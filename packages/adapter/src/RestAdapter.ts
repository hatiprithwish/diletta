import * as Schemas from "@app/schemas";
import { getAuthStrategy } from "./AuthStrategies";
import { buildHostUrl, defaultHostRetryWait, parseHostBaseUrl, sendHostAttempt } from "./HostHttp";

// DEV_NOTE: The REST adapter (adapter_type 1). Sends requests rendered by renderToolOp to the connection's base_url
// as the chatbot user (AuthStrategy), and applies the retry rules of each call kind:
//   Read (a read tool's call_op, every readback_op): 408 / 429 / 5xx / no answer retried.
//   Write: a 429 is always resent (the host didn't run it). Any other answer that may have landed (408 / 5xx / no
//     answer, and a 409 for Native) follows the tool's idempotency mode (afterMaybeLanded):
//     Native: resent with the same Idempotency-Key, so the host runs it once.
//     Emulated: read back first (appliedCheck). Shows the step's values → AlreadyApplied; still shows the values it
//       replaces → resent; anything else (unreadable, or a value stored in another form) → Unknown, never resent.
//     None: Unknown, never resent.
// A 3xx is never followed. A write's 3xx may have landed (POST / redirect / GET), so it's Unknown and not resent.
// Pure: no DB, no logger, never throws; messages carry no token, body or args, so the caller can log them.
// Known limit: an Emulated check reads the host right after a failed attempt, so a host that applies writes late
// (eventual consistency) can still see a resend twice. Such a host's tools should be Native or None.

const READBACK_NOT_GET_MESSAGE = "A readback is a GET";

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function isSuccessOutcome(outcome: Schemas.HostCallOutcomeEnum): boolean {
  return (
    outcome === Schemas.HostCallOutcomeEnum.Succeeded ||
    outcome === Schemas.HostCallOutcomeEnum.AlreadyApplied
  );
}

function retryDelayMs(retry: number, retryAfterMs: number | null): number {
  return retryAfterMs ?? Schemas.HOST_CALL_RETRY_BASE_MS * 2 ** retry;
}

// The one response builder: a read passes its attempts, a write its attempts and mayHaveLanded
function toResponse(
  outcome: Schemas.HostCallOutcomeEnum,
  message: string | undefined,
  state: Schemas.HostWriteState | Pick<Schemas.HostWriteState, "attempts">,
  extra: Pick<Schemas.HostCallResponse, "httpStatus" | "body"> = {},
): Schemas.HostCallResponse {
  return { isSuccess: isSuccessOutcome(outcome), outcome, message, ...state, ...extra };
}

// DEV_NOTE: A write's failure: Unknown instead of Refused / Failed once one of its sends may have landed
function failUnlessMaybeLanded(
  outcome: Schemas.HostCallOutcomeEnum.Refused | Schemas.HostCallOutcomeEnum.Failed,
  message: string,
  state: Schemas.HostWriteState,
  httpStatus?: number,
): Schemas.HostCallResponse {
  return state.mayHaveLanded
    ? toResponse(
        Schemas.HostCallOutcomeEnum.Unknown,
        `${message}, after a send that may have landed`,
        state,
        { httpStatus },
      )
    : toResponse(outcome, message, state, { httpStatus });
}

export default class RestAdapter implements Schemas.HostAdapter {
  private constructor(
    private readonly baseUrl: URL,
    private readonly strategy: Schemas.HostAuthStrategy,
    private readonly authConfig: unknown,
    private readonly getHostToken: Schemas.HostTokenSource,
    private readonly fetchFn: typeof fetch,
    private readonly wait: Schemas.HostRetryWait,
  ) {}

  // DEV_NOTE: The connection must be REST with a trusted base_url and an auth type that has a strategy and a valid
  // config. Checked once here, so a bad connection fails before any call.
  static create(params: Schemas.CreateHostAdapterRequest): Schemas.CreateHostAdapterResponse {
    const { connection } = params;
    if (connection.adapterType !== Schemas.CompanyConnectionAdapterTypeIntEnum.Rest) {
      return { isSuccess: false, message: "Connection is not a REST connection" };
    }
    if (!connection.baseUrl) return { isSuccess: false, message: "Connection has no base URL" };
    const baseUrl = parseHostBaseUrl(connection.baseUrl);
    if (!baseUrl.isSuccess) return { isSuccess: false, message: baseUrl.message };
    const issue = Schemas.getAuthConfigIssue(connection);
    const strategy = getAuthStrategy(connection.authType);
    if (issue || !strategy) {
      return { isSuccess: false, message: issue ?? "Auth type has no strategy" };
    }

    return {
      isSuccess: true,
      message: "Adapter created successfully",
      adapter: new RestAdapter(
        baseUrl.baseUrl,
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
      return toResponse(Schemas.HostCallOutcomeEnum.Failed, READBACK_NOT_GET_MESSAGE, {
        attempts: 0,
      });
    }
    return await this.read(call);
  }

  async undo(call: Schemas.HostWriteCall): Promise<Schemas.HostCallResponse> {
    return await this.write(call);
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
    const state = { attempts: 0 };
    const fail = (message: string, httpStatus?: number) =>
      toResponse(Schemas.HostCallOutcomeEnum.Failed, message, state, { httpStatus });

    const prepared = this.prepare(call.request);
    if (!prepared.isSuccess) return fail(prepared.message);

    for (let retry = 0; ; retry++) {
      if (call.signal?.aborted) return fail("Call aborted");
      const sent = await this.send(prepared.url, call.request, call.signal, {});
      if (!sent.isSent) {
        return toResponse(
          sent.auth.failureOutcome ?? Schemas.HostCallOutcomeEnum.Failed,
          sent.auth.message,
          state,
        );
      }
      state.attempts++;
      const { result } = sent;
      const canRetry = retry < Schemas.HOST_CALL_MAX_RETRIES;

      if (result.kind !== Schemas.HostAttemptKindEnum.Answered) {
        if (result.kind === Schemas.HostAttemptKindEnum.Aborted) return fail("Call aborted");
        if (!canRetry) return fail("Host didn't answer");
        await this.wait(retryDelayMs(retry, null), call.signal);
        continue;
      }

      const httpStatus = result.status;
      if (isSuccessStatus(httpStatus)) {
        if (!result.isReadable) return fail("Host response is unreadable", httpStatus);
        return toResponse(Schemas.HostCallOutcomeEnum.Succeeded, "Host call succeeded", state, {
          httpStatus,
          body: result.body,
        });
      }
      if (httpStatus === 401) {
        return toResponse(
          Schemas.HostCallOutcomeEnum.TokenRejected,
          "Host rejected the token",
          state,
          { httpStatus },
        );
      }
      if (isRetryableStatus(httpStatus) && canRetry) {
        await this.wait(retryDelayMs(retry, result.retryAfterMs), call.signal);
        continue;
      }
      if (isRedirectStatus(httpStatus)) return fail("Host redirect not followed", httpStatus);
      if (isRetryableStatus(httpStatus)) {
        return fail(`Host kept failing (${httpStatus})`, httpStatus);
      }
      return toResponse(
        Schemas.HostCallOutcomeEnum.Refused,
        `Host refused the call (${httpStatus})`,
        state,
        { httpStatus },
      );
    }
  }

  // DEV_NOTE: Did an Emulated write land? Reads the tool's readback (read rules, same token): the step's values →
  // Applied; the values it replaces → NotApplied (safe to resend); neither → Inconclusive. Nothing to compare proves
  // nothing, so it is Inconclusive too. Landed is checked first: a step that changes nothing reads as landed.
  private async checkApplied(call: Schemas.HostWriteCall): Promise<Schemas.HostAppliedCheckResult> {
    const check = call.appliedCheck;
    if (!check || check.expectations.landed.length === 0) {
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
    if (Schemas.compareReadback(check.expectations.landed, read.body).isMatch) {
      return { state: Schemas.HostAppliedCheckStateEnum.Applied };
    }
    if (Schemas.compareReadback(check.expectations.notLanded, read.body).isMatch) {
      return { state: Schemas.HostAppliedCheckStateEnum.NotApplied };
    }
    return {
      state: Schemas.HostAppliedCheckStateEnum.Inconclusive,
      message: "Readback matches neither the written nor the earlier values",
    };
  }

  // DEV_NOTE: The Emulated check as a write's answer: null = didn't land, carry on. An Inconclusive check passes on a
  // token outcome (so the token can be refreshed), else Unknown; mayHaveLanded stays set either way.
  private async checkBeforeResend(
    call: Schemas.HostWriteCall,
    state: Schemas.HostWriteState,
  ): Promise<Schemas.HostCallResponse | null> {
    const check = await this.checkApplied(call);
    if (check.state === Schemas.HostAppliedCheckStateEnum.Applied) {
      return toResponse(
        Schemas.HostCallOutcomeEnum.AlreadyApplied,
        "Write had already landed",
        state,
      );
    }
    if (check.state === Schemas.HostAppliedCheckStateEnum.NotApplied) {
      state.mayHaveLanded = false;
      return null;
    }
    const outcome =
      check.outcome === Schemas.HostCallOutcomeEnum.TokenNeeded ||
      check.outcome === Schemas.HostCallOutcomeEnum.TokenRejected
        ? check.outcome
        : Schemas.HostCallOutcomeEnum.Unknown;
    return toResponse(outcome, check.message, state);
  }

  // DEV_NOTE: Before a resumed write's first send (isResume: an earlier call may have landed). null = send it.
  private async onResume(
    call: Schemas.HostWriteCall,
    state: Schemas.HostWriteState,
  ): Promise<Schemas.HostCallResponse | null> {
    switch (call.idempotencyMode) {
      case Schemas.ToolDefinitionIdempotencyModeIntEnum.Native:
        return null;
      case Schemas.ToolDefinitionIdempotencyModeIntEnum.Emulated:
        return await this.checkBeforeResend(call, state);
      case Schemas.ToolDefinitionIdempotencyModeIntEnum.None:
        return toResponse(
          Schemas.HostCallOutcomeEnum.Unknown,
          "A write with no idempotency that may have landed is never resent",
          state,
        );
    }
  }

  // DEV_NOTE: After a send that may have landed (state.mayHaveLanded is set). null = send again. On the last try
  // Emulated still checks, so a write that landed then is AlreadyApplied, and one that didn't is Failed, not Unknown.
  private async afterMaybeLanded(
    call: Schemas.HostWriteCall,
    state: Schemas.HostWriteState,
    params: { retry: number; retryAfterMs: number | null; httpStatus?: number },
  ): Promise<Schemas.HostCallResponse | null> {
    const isLastTry = params.retry >= Schemas.HOST_CALL_MAX_RETRIES;
    const unknown = () =>
      toResponse(Schemas.HostCallOutcomeEnum.Unknown, "Write may or may not have landed", state, {
        httpStatus: params.httpStatus,
      });

    switch (call.idempotencyMode) {
      case Schemas.ToolDefinitionIdempotencyModeIntEnum.None:
        return unknown();
      case Schemas.ToolDefinitionIdempotencyModeIntEnum.Native:
        if (isLastTry) return unknown();
        await this.wait(retryDelayMs(params.retry, params.retryAfterMs), call.signal);
        return null;
      case Schemas.ToolDefinitionIdempotencyModeIntEnum.Emulated: {
        await this.wait(retryDelayMs(params.retry, params.retryAfterMs), call.signal);
        const checked = await this.checkBeforeResend(call, state);
        if (checked || !isLastTry) return checked;
        return failUnlessMaybeLanded(
          Schemas.HostCallOutcomeEnum.Failed,
          "Host kept failing; the write didn't land",
          state,
          params.httpStatus,
        );
      }
    }
  }

  // Why a write call can't be sent at all, or null
  private getWriteCallIssue(call: Schemas.HostWriteCall): string | null {
    const mode = call.idempotencyMode;
    if (
      mode !== Schemas.ToolDefinitionIdempotencyModeIntEnum.None &&
      !Schemas.HOST_IDEMPOTENCY_KEY_PATTERN.test(call.idempotencyKey)
    ) {
      return "Invalid idempotency key";
    }
    if (mode === Schemas.ToolDefinitionIdempotencyModeIntEnum.Emulated) {
      if (!call.appliedCheck) return "Emulated idempotency needs a readback check";
      if (call.appliedCheck.request.method !== Schemas.ToolOpMethodEnum.Get) {
        return READBACK_NOT_GET_MESSAGE;
      }
    }
    return null;
  }

  private async write(call: Schemas.HostWriteCall): Promise<Schemas.HostCallResponse> {
    const state: Schemas.HostWriteState = { attempts: 0, mayHaveLanded: call.isResume };

    const issue = this.getWriteCallIssue(call);
    if (issue) return failUnlessMaybeLanded(Schemas.HostCallOutcomeEnum.Failed, issue, state);
    const prepared = this.prepare(call.request);
    if (!prepared.isSuccess) {
      return failUnlessMaybeLanded(Schemas.HostCallOutcomeEnum.Failed, prepared.message, state);
    }
    if (call.isResume) {
      const resumed = await this.onResume(call, state);
      if (resumed) return resumed;
    }

    const extraHeaders: Record<string, string> =
      call.idempotencyMode === Schemas.ToolDefinitionIdempotencyModeIntEnum.Native
        ? { [Schemas.HOST_IDEMPOTENCY_KEY_HEADER]: call.idempotencyKey }
        : {};

    for (let retry = 0; ; retry++) {
      if (call.signal?.aborted) {
        return failUnlessMaybeLanded(Schemas.HostCallOutcomeEnum.Failed, "Call aborted", state);
      }
      const sent = await this.send(prepared.url, call.request, call.signal, extraHeaders);
      if (!sent.isSent) {
        return toResponse(
          sent.auth.failureOutcome ?? Schemas.HostCallOutcomeEnum.Failed,
          sent.auth.message,
          state,
        );
      }
      state.attempts++;
      const { result } = sent;

      if (result.kind !== Schemas.HostAttemptKindEnum.Answered) {
        state.mayHaveLanded = true;
        if (result.kind === Schemas.HostAttemptKindEnum.Aborted) {
          return toResponse(
            Schemas.HostCallOutcomeEnum.Unknown,
            "Call aborted after it was sent",
            state,
          );
        }
        const next = await this.afterMaybeLanded(call, state, { retry, retryAfterMs: null });
        if (next) return next;
        continue;
      }

      const httpStatus = result.status;
      if (isSuccessStatus(httpStatus)) {
        state.mayHaveLanded = true;
        return toResponse(Schemas.HostCallOutcomeEnum.Succeeded, "Host call succeeded", state, {
          httpStatus,
          body: result.isReadable ? result.body : undefined,
        });
      }
      if (httpStatus === 401) {
        return toResponse(
          Schemas.HostCallOutcomeEnum.TokenRejected,
          "Host rejected the token",
          state,
          { httpStatus },
        );
      }
      if (httpStatus === 429) {
        if (retry < Schemas.HOST_CALL_MAX_RETRIES) {
          await this.wait(retryDelayMs(retry, result.retryAfterMs), call.signal);
          continue;
        }
        return failUnlessMaybeLanded(
          Schemas.HostCallOutcomeEnum.Failed,
          "Host kept rate limiting the call",
          state,
          httpStatus,
        );
      }
      if (isRedirectStatus(httpStatus)) {
        state.mayHaveLanded = true;
        return toResponse(
          Schemas.HostCallOutcomeEnum.Unknown,
          "Host redirect not followed",
          state,
          { httpStatus },
        );
      }
      const isMaybeLanded =
        isRetryableStatus(httpStatus) ||
        (httpStatus === 409 &&
          call.idempotencyMode === Schemas.ToolDefinitionIdempotencyModeIntEnum.Native);
      if (!isMaybeLanded) {
        return failUnlessMaybeLanded(
          Schemas.HostCallOutcomeEnum.Refused,
          `Host refused the call (${httpStatus})`,
          state,
          httpStatus,
        );
      }
      state.mayHaveLanded = true;
      const next = await this.afterMaybeLanded(call, state, {
        retry,
        retryAfterMs: result.retryAfterMs,
        httpStatus,
      });
      if (next) return next;
    }
  }
}
