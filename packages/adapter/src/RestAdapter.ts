import * as Schemas from "@app/schemas";
import { getAuthStrategy } from "./AuthStrategies";
import { buildHostUrl, defaultHostRetryWait, sendHostAttempt } from "./HostHttp";

// DEV_NOTE: The REST adapter (adapter_type 1). Sends requests rendered by renderToolOp to the connection's base_url
// as the chatbot user (AuthStrategy), and applies the retry rules of each call kind:
//   Read (a read tool's call_op, every readback_op): 408 / 429 / 5xx / no answer retried.
//   Write, Native: the same, plus 409 (the host still running the same key), every attempt with the same
//     Idempotency-Key, so the host runs it once.
//   Write, Emulated: a 429 is resent; any answer that may have landed (408 / 5xx / no answer) is first checked with the
//     tool's readback (appliedCheck): landed → AlreadyApplied, not landed → resent, unreadable → Unknown.
//   Write, None: only a 429 is resent; anything that may have landed → Unknown.
// A 3xx is never followed. A write's 3xx may have landed (POST / redirect / GET), so it's Unknown and not resent.
// Pure: no DB, no logger, never throws; messages carry no token, body or args, so the caller can log them.
// Known limit: an Emulated check reads the host right after a failed attempt, so a host that applies writes late
// (eventual consistency) can still see a resend twice. Such a host's tools should be Native or None.

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function retryDelayMs(retry: number, retryAfterMs: number | null): number {
  return retryAfterMs ?? Schemas.HOST_CALL_RETRY_BASE_MS * 2 ** retry;
}

export default class RestAdapter implements Schemas.HostAdapter {
  private constructor(
    private readonly baseUrl: string,
    private readonly strategy: Schemas.HostAuthStrategy,
    private readonly authConfig: unknown,
    private readonly getHostToken: Schemas.HostTokenSource,
    private readonly fetchFn: typeof fetch,
    private readonly wait: Schemas.HostRetryWait,
  ) {}

  // DEV_NOTE: The connection must be REST with a base_url and an auth type that has a strategy and a valid config
  static create(params: Schemas.CreateHostAdapterRequest): Schemas.CreateHostAdapterResponse {
    const { connection } = params;
    if (connection.adapterType !== Schemas.CompanyConnectionAdapterTypeIntEnum.Rest) {
      return { isSuccess: false, message: "Connection is not a REST connection" };
    }
    if (!connection.baseUrl) return { isSuccess: false, message: "Connection has no base URL" };
    const issue = Schemas.getAuthConfigIssue(connection);
    const strategy = getAuthStrategy(connection.authType);
    if (issue || !strategy) {
      return { isSuccess: false, message: issue ?? "Auth type has no strategy" };
    }

    return {
      isSuccess: true,
      message: "Adapter created successfully",
      adapter: new RestAdapter(
        connection.baseUrl,
        strategy,
        connection.authConfig,
        params.getHostToken,
        params.fetch ?? ((input, init) => fetch(input, init)),
        params.wait ?? defaultHostRetryWait,
      ),
    };
  }

  async execute(call: Schemas.HostExecuteCall): Promise<Schemas.HostCallResponse> {
    return call.risk === Schemas.ToolDefinitionRiskIntEnum.Read
      ? await this.read(call)
      : await this.write(call);
  }

  async readback(call: Schemas.HostReadCall): Promise<Schemas.HostCallResponse> {
    if (call.request.method !== Schemas.ToolOpMethodEnum.Get) {
      return this.failed("A readback is a GET", 0);
    }
    return await this.read(call);
  }

  async undo(call: Schemas.HostWriteCall): Promise<Schemas.HostCallResponse> {
    return await this.write(call);
  }

  private failed(message: string, attempts: number): Schemas.HostCallResponse {
    return { isSuccess: false, outcome: Schemas.HostCallOutcomeEnum.Failed, message, attempts };
  }

  private prepare(request: Schemas.RenderedToolRequest): Schemas.HostUrlResult {
    if (request.method === Schemas.ToolOpMethodEnum.Get && request.body !== undefined) {
      return { isSuccess: false, message: "A GET has no body" };
    }
    return buildHostUrl(this.baseUrl, request);
  }

  private async send(
    url: URL,
    request: Schemas.RenderedToolRequest,
    signal: AbortSignal | undefined,
    extraHeaders: Record<string, string>,
  ): Promise<
    | { isSent: true; result: Schemas.HostAttemptResult }
    | { isSent: false; auth: Schemas.HostAuthHeadersResponse }
  > {
    const auth = this.strategy.getHeaders({
      authConfig: this.authConfig,
      getHostToken: this.getHostToken,
    });
    if (!auth.isSuccess || !auth.headers) return { isSent: false, auth };
    const result = await sendHostAttempt({
      fetch: this.fetchFn,
      url,
      request,
      headers: { ...extraHeaders, ...auth.headers },
      signal,
    });
    return { isSent: true, result };
  }

  private async read(call: Schemas.HostReadCall): Promise<Schemas.HostCallResponse> {
    const prepared = this.prepare(call.request);
    if (!prepared.isSuccess) return this.failed(prepared.message, 0);

    let attempts = 0;
    for (let retry = 0; ; retry++) {
      if (call.signal?.aborted) return this.failed("Call aborted", attempts);
      const sent = await this.send(prepared.url, call.request, call.signal, {});
      if (!sent.isSent) {
        return {
          isSuccess: false,
          outcome: sent.auth.failureOutcome ?? Schemas.HostCallOutcomeEnum.Failed,
          message: sent.auth.message,
          attempts,
        };
      }
      attempts++;
      const { result } = sent;

      if (result.kind !== Schemas.HostAttemptKindEnum.Answered) {
        if (result.kind === Schemas.HostAttemptKindEnum.Aborted) {
          return this.failed("Call aborted", attempts);
        }
        if (retry < Schemas.HOST_CALL_MAX_RETRIES) {
          await this.wait(retryDelayMs(retry, null), call.signal);
          continue;
        }
        return this.failed("Host didn't answer", attempts);
      }

      const httpStatus = result.status;
      if (isSuccessStatus(httpStatus)) {
        if (!result.isReadable) {
          return { ...this.failed("Host response is unreadable", attempts), httpStatus };
        }
        return {
          isSuccess: true,
          outcome: Schemas.HostCallOutcomeEnum.Succeeded,
          message: "Host call succeeded",
          httpStatus,
          body: result.body,
          attempts,
        };
      }
      if (httpStatus === 401) {
        return {
          isSuccess: false,
          outcome: Schemas.HostCallOutcomeEnum.TokenRejected,
          message: "Host rejected the token",
          httpStatus,
          attempts,
        };
      }
      if (isRetryableStatus(httpStatus) && retry < Schemas.HOST_CALL_MAX_RETRIES) {
        await this.wait(retryDelayMs(retry, result.retryAfterMs), call.signal);
        continue;
      }
      if (isRedirectStatus(httpStatus)) {
        return { ...this.failed("Host redirect not followed", attempts), httpStatus };
      }
      if (isRetryableStatus(httpStatus)) {
        return { ...this.failed(`Host kept failing (${httpStatus})`, attempts), httpStatus };
      }
      return {
        isSuccess: false,
        outcome: Schemas.HostCallOutcomeEnum.Refused,
        message: `Host refused the call (${httpStatus})`,
        httpStatus,
        attempts,
      };
    }
  }

  // DEV_NOTE: Did an Emulated write land? Reads the tool's readback (read rules, same token) and compares it with the
  // expectations. No expectations proves nothing, so it is Inconclusive, never Applied.
  private async checkApplied(call: Schemas.HostWriteCall): Promise<Schemas.HostAppliedCheckResult> {
    const check = call.appliedCheck;
    if (!check || check.expectations.length === 0) {
      return {
        state: Schemas.HostAppliedCheckStateEnum.Inconclusive,
        message: "Nothing to compare the readback with",
      };
    }
    const read = await this.readback({ request: check.request, signal: call.signal });
    if (!read.isSuccess) {
      return {
        state: Schemas.HostAppliedCheckStateEnum.Inconclusive,
        outcome: read.outcome,
        message: `Readback check failed: ${read.message ?? read.outcome}`,
      };
    }
    return Schemas.compareReadback(check.expectations, read.body).isMatch
      ? { state: Schemas.HostAppliedCheckStateEnum.Applied }
      : { state: Schemas.HostAppliedCheckStateEnum.NotApplied };
  }

  private async write(call: Schemas.HostWriteCall): Promise<Schemas.HostCallResponse> {
    const mode = call.idempotencyMode;
    let attempts = 0;
    let mayHaveLanded = call.isResume;

    const end = (
      outcome: Schemas.HostCallOutcomeEnum,
      message: string | undefined,
      extra: Pick<Schemas.HostCallResponse, "httpStatus" | "body"> = {},
    ): Schemas.HostCallResponse => ({
      isSuccess:
        outcome === Schemas.HostCallOutcomeEnum.Succeeded ||
        outcome === Schemas.HostCallOutcomeEnum.AlreadyApplied,
      outcome,
      message,
      attempts,
      mayHaveLanded,
      ...extra,
    });
    // DEV_NOTE: A failure after a send that may have landed is Unknown, never Failed / Refused
    const notLanded = (
      outcome: Schemas.HostCallOutcomeEnum,
      message: string,
      httpStatus?: number,
    ) =>
      mayHaveLanded
        ? end(
            Schemas.HostCallOutcomeEnum.Unknown,
            `${message}, after a send that may have landed`,
            {
              httpStatus,
            },
          )
        : end(outcome, message, { httpStatus });
    // Runs the Emulated check; undefined = not landed, carry on and send
    const checkOrEnd = async (): Promise<Schemas.HostCallResponse | undefined> => {
      const check = await this.checkApplied(call);
      if (check.state === Schemas.HostAppliedCheckStateEnum.Applied) {
        return end(Schemas.HostCallOutcomeEnum.AlreadyApplied, "Write had already landed");
      }
      if (check.state === Schemas.HostAppliedCheckStateEnum.NotApplied) {
        mayHaveLanded = false;
        return undefined;
      }
      const isTokenOutcome =
        check.outcome === Schemas.HostCallOutcomeEnum.TokenNeeded ||
        check.outcome === Schemas.HostCallOutcomeEnum.TokenRejected;
      return end(
        isTokenOutcome && check.outcome ? check.outcome : Schemas.HostCallOutcomeEnum.Unknown,
        check.message,
      );
    };

    if (
      mode !== Schemas.ToolDefinitionIdempotencyModeIntEnum.None &&
      !Schemas.HOST_IDEMPOTENCY_KEY_PATTERN.test(call.idempotencyKey)
    ) {
      return notLanded(Schemas.HostCallOutcomeEnum.Failed, "Invalid idempotency key");
    }
    if (mode === Schemas.ToolDefinitionIdempotencyModeIntEnum.Emulated) {
      if (!call.appliedCheck) {
        return notLanded(
          Schemas.HostCallOutcomeEnum.Failed,
          "Emulated idempotency needs a readback check",
        );
      }
      if (call.appliedCheck.request.method !== Schemas.ToolOpMethodEnum.Get) {
        return notLanded(Schemas.HostCallOutcomeEnum.Failed, "A readback is a GET");
      }
    }
    const prepared = this.prepare(call.request);
    if (!prepared.isSuccess) {
      return notLanded(Schemas.HostCallOutcomeEnum.Failed, prepared.message);
    }

    if (call.isResume) {
      if (mode === Schemas.ToolDefinitionIdempotencyModeIntEnum.None) {
        return end(
          Schemas.HostCallOutcomeEnum.Unknown,
          "A write with no idempotency that may have landed is never resent",
        );
      }
      if (mode === Schemas.ToolDefinitionIdempotencyModeIntEnum.Emulated) {
        const ended = await checkOrEnd();
        if (ended) return ended;
      }
    }

    const extraHeaders: Record<string, string> =
      mode === Schemas.ToolDefinitionIdempotencyModeIntEnum.Native
        ? { [Schemas.HOST_IDEMPOTENCY_KEY_HEADER]: call.idempotencyKey }
        : {};

    for (let retry = 0; ; retry++) {
      if (call.signal?.aborted) {
        return notLanded(Schemas.HostCallOutcomeEnum.Failed, "Call aborted");
      }
      const sent = await this.send(prepared.url, call.request, call.signal, extraHeaders);
      if (!sent.isSent) {
        return end(
          sent.auth.failureOutcome ?? Schemas.HostCallOutcomeEnum.Failed,
          sent.auth.message,
        );
      }
      attempts++;
      const { result } = sent;

      if (result.kind === Schemas.HostAttemptKindEnum.Aborted) {
        mayHaveLanded = true;
        return end(Schemas.HostCallOutcomeEnum.Unknown, "Call aborted after it was sent");
      }

      let retryAfterMs: number | null = null;
      if (result.kind === Schemas.HostAttemptKindEnum.Answered) {
        const httpStatus = result.status;
        if (isSuccessStatus(httpStatus)) {
          mayHaveLanded = true;
          return end(Schemas.HostCallOutcomeEnum.Succeeded, "Host call succeeded", {
            httpStatus,
            body: result.isReadable ? result.body : undefined,
          });
        }
        if (httpStatus === 401) {
          return end(Schemas.HostCallOutcomeEnum.TokenRejected, "Host rejected the token", {
            httpStatus,
          });
        }
        if (httpStatus === 429) {
          if (retry < Schemas.HOST_CALL_MAX_RETRIES) {
            await this.wait(retryDelayMs(retry, result.retryAfterMs), call.signal);
            continue;
          }
          return notLanded(
            Schemas.HostCallOutcomeEnum.Failed,
            "Host kept rate limiting the call",
            httpStatus,
          );
        }
        if (isRedirectStatus(httpStatus)) {
          mayHaveLanded = true;
          return end(Schemas.HostCallOutcomeEnum.Unknown, "Host redirect not followed", {
            httpStatus,
          });
        }
        const isUncertain =
          isRetryableStatus(httpStatus) ||
          (httpStatus === 409 && mode === Schemas.ToolDefinitionIdempotencyModeIntEnum.Native);
        if (!isUncertain) {
          return notLanded(
            Schemas.HostCallOutcomeEnum.Refused,
            `Host refused the call (${httpStatus})`,
            httpStatus,
          );
        }
        retryAfterMs = result.retryAfterMs;
      }

      // No answer, 408, 5xx (or a Native 409): this send may have landed
      mayHaveLanded = true;
      if (
        mode === Schemas.ToolDefinitionIdempotencyModeIntEnum.None ||
        retry >= Schemas.HOST_CALL_MAX_RETRIES
      ) {
        return end(Schemas.HostCallOutcomeEnum.Unknown, "Write may or may not have landed", {
          httpStatus:
            result.kind === Schemas.HostAttemptKindEnum.Answered ? result.status : undefined,
        });
      }
      await this.wait(retryDelayMs(retry, retryAfterMs), call.signal);
      if (mode === Schemas.ToolDefinitionIdempotencyModeIntEnum.Emulated) {
        const ended = await checkOrEnd();
        if (ended) return ended;
      }
    }
  }
}
