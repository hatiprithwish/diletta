import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import ChatbotConfigsDAL from "@/data-access-layer/ChatbotConfigsDAL";
import ChatbotsDAL from "@/data-access-layer/ChatbotsDAL";
import CompanyConnectionsDAL from "@/data-access-layer/CompanyConnectionsDAL";
import EvalCasesDAL from "@/data-access-layer/EvalCasesDAL";
import EvalRunsDAL from "@/data-access-layer/EvalRunsDAL";
import FilesDAL from "@/data-access-layer/FilesDAL";
import getDbClient from "@/db/dbClient";
import withTenant from "@/db/withTenant";
import EvalRunsProvider from "@/providers/evalRuns";
import FileStorageProvider from "@/providers/fileStorage";
import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";

type Tx = NodePgTransaction<EmptyRelations>;

// DEV_NOTE: The transcript's R2 key, found in one withTenant before the object is read outside it
type TranscriptKey =
  | { isSuccess: true; key: string; sizeBytes: number }
  | Schemas.GetEvalTranscriptApiResponse;

// DEV_NOTE: Tenant Repo — eval runs as the Tests page reads them (M4-8): the runs list, the metric strip, one run, its
// cases, one case's attempts with their grader output, and an attempt's transcript from R2. Read only: the eval harness
// (M5-2) writes runs and results, M5-3 the transcripts. Grader output and transcripts are read only through their
// parsers (Schemas.parseEvalGraderOutput / parseEvalTranscript); the raw R2 bytes never reach the client.
export default class EvalRunsRepo {
  private env: Env;
  private db: NodePgDatabase;
  private evalRunsDal: EvalRunsDAL;
  private evalCasesDal: EvalCasesDAL;
  private chatbotsDal: ChatbotsDAL;
  private chatbotConfigsDal: ChatbotConfigsDAL;
  private companyConnectionsDal: CompanyConnectionsDAL;
  private filesDal: FilesDAL;

  constructor(env: Env) {
    this.env = env;
    this.db = getDbClient(env);
    this.evalRunsDal = new EvalRunsDAL();
    this.evalCasesDal = new EvalCasesDAL();
    this.chatbotsDal = new ChatbotsDAL();
    this.chatbotConfigsDal = new ChatbotConfigsDAL();
    this.companyConnectionsDal = new CompanyConnectionsDAL();
    this.filesDal = new FilesDAL();
  }

  // DEV_NOTE: Status Enum Pattern — trigger, status and the config's status each as int + label
  private toListItem(
    row: Schemas.DashboardEvalRunRow,
    safety: Schemas.EvalRunListItem["safety"],
  ): Schemas.EvalRunListItem {
    return {
      publicId: row.publicId,
      trigger: row.trigger,
      triggerLabel: Schemas.EVAL_RUN_TRIGGER_LABEL_MAP[row.trigger],
      evalRunStatus: row.status,
      evalRunStatusLabel: Schemas.EVAL_RUN_STATUS_LABEL_MAP[row.status],
      config: {
        publicId: row.configPublicId,
        configVersion: row.configVersion,
        chatbotConfigStatus: row.configStatus,
        chatbotConfigStatusLabel: Schemas.CHATBOT_CONFIG_STATUS_LABEL_MAP[row.configStatus],
        chatbotName: row.chatbotName,
      },
      k: row.k,
      caseCount: row.caseCount,
      passAllKCount: row.passAllKCount,
      safety,
      hasPassed: row.hasPassed,
      costUsd: row.costUsd,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  // DEV_NOTE: Runs as list items, with each one's safety tally read in one query
  private async toListItems(
    tx: Tx,
    companyId: string,
    rows: Schemas.DashboardEvalRunRow[],
  ): Promise<{ isSuccess: true; items: Schemas.EvalRunListItem[] } | Schemas.ApiResponse> {
    const safety = await this.evalRunsDal.getEvalRunSafetyCases(tx, {
      companyId,
      evalRunIds: rows.map((row) => row.id),
    });
    if (!safety.isSuccess) return { isSuccess: false, message: safety.message };
    const tallies = EvalRunsProvider.safetyTallies(rows, safety.safetyCases ?? []);
    return {
      isSuccess: true,
      items: rows.map((row) =>
        this.toListItem(row, tallies.get(row.id) ?? { passedCount: 0, totalCount: 0 }),
      ),
    };
  }

  async getEvalRuns(
    params: Schemas.GetEvalRunsApiRequest & { companyId: string },
  ): Promise<Schemas.GetEvalRunsApiResponse> {
    const { companyId } = params;
    return await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.GetEvalRunsApiResponse> => {
        let chatbotId: string | null = null;
        if (params.botId !== undefined) {
          const chatbot = await this.chatbotsDal.getChatbotDetails(tx, {
            companyId,
            publicId: params.botId,
          });
          if (!chatbot.isSuccess || !chatbot.chatbot) {
            return { isSuccess: false, message: chatbot.message, isNotFound: chatbot.isNotFound };
          }
          chatbotId = chatbot.chatbot.id;
        }

        const page = await this.evalRunsDal.getEvalRuns(tx, {
          companyId,
          chatbotId,
          pageNo: params.pageNo ?? Constants.DEFAULT_PAGE_NO,
          pageSize: params.pageSize ?? Constants.DEFAULT_PAGE_SIZE,
          sortColumn: params.sortColumn ?? Schemas.EvalRunSortColumn.CreatedAt,
          sortDirection: params.sortDirection ?? Schemas.SortDirection.Desc,
        });
        if (!page.isSuccess) return { isSuccess: false, message: page.message };

        const counted = await this.evalRunsDal.getEvalRunsCount(tx, { companyId, chatbotId });
        if (!counted.isSuccess) return { isSuccess: false, message: counted.message };

        const listed = await this.toListItems(tx, companyId, page.evalRuns ?? []);
        if (!("items" in listed)) return listed;

        return {
          isSuccess: true,
          message: "Eval runs fetched successfully",
          evalRuns: listed.items,
          totalRecords: counted.totalRecords ?? 0,
        };
      },
    );
  }

  // DEV_NOTE: The metric strip for one chatbot (botId's, else the company's default; none = an empty summary): its
  // active cases (its own and the platform's), the live config's gate run (approved_by_run_id, else its newest run), the
  // newest draft's newest run, and the staging host the tests run against. One read-only withTenant.
  async getEvalRunsSummary(
    params: Schemas.GetEvalRunsSummaryApiRequest & { companyId: string },
  ): Promise<Schemas.GetEvalRunsSummaryApiResponse> {
    const { companyId } = params;
    return await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.GetEvalRunsSummaryApiResponse> => {
        const connections = await this.companyConnectionsDal.getCompanyConnections(tx, {
          companyId,
        });
        if (!connections.isSuccess) return { isSuccess: false, message: connections.message };
        const staging = EvalRunsProvider.stagingHost(connections.companyConnections ?? []);

        const found =
          params.botId !== undefined
            ? await this.chatbotsDal.getChatbotDetails(tx, { companyId, publicId: params.botId })
            : await this.chatbotsDal.getDefaultChatbot(tx, { companyId });
        if (!found.isSuccess || !found.chatbot) {
          // DEV_NOTE: No default chatbot yet: nothing to summarise, but not an error (an unknown botId is a 404)
          if (found.isNotFound && params.botId === undefined) {
            return {
              isSuccess: true,
              message: "Eval runs summary fetched successfully",
              summary: {
                chatbot: null,
                caseCount: 0,
                safetyCaseCount: 0,
                live: null,
                draft: null,
                staging,
              },
            };
          }
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        const { chatbot } = found;

        const counted = await this.evalCasesDal.countActiveEvalCases(tx, {
          companyId,
          chatbotId: chatbot.id,
        });
        if (!counted.isSuccess) return { isSuccess: false, message: counted.message };

        const published = await this.chatbotConfigsDal.getPublishedChatbotConfig(tx, {
          companyId,
          chatbotId: chatbot.id,
        });
        if (!published.isSuccess && !published.isNotFound) {
          return { isSuccess: false, message: published.message };
        }
        const draft = await this.chatbotConfigsDal.getLatestDraftChatbotConfig(tx, {
          companyId,
          chatbotId: chatbot.id,
        });
        if (!draft.isSuccess && !draft.isNotFound) {
          return { isSuccess: false, message: draft.message };
        }

        const liveRun = published.chatbotConfig
          ? await this.configRun(tx, companyId, published.chatbotConfig)
          : { isSuccess: true as const, run: null };
        if (!("run" in liveRun)) return liveRun;
        const draftRun = draft.chatbotConfig
          ? await this.configRun(tx, companyId, draft.chatbotConfig)
          : { isSuccess: true as const, run: null };
        if (!("run" in draftRun)) return draftRun;

        const runs = [liveRun.run, draftRun.run].filter(
          (run): run is Schemas.DashboardEvalRunRow => run !== null,
        );
        const listed = await this.toListItems(tx, companyId, runs);
        if (!("items" in listed)) return listed;
        const itemOf = (run: Schemas.DashboardEvalRunRow | null) =>
          run === null
            ? null
            : (listed.items.find((item) => item.publicId === run.publicId) ?? null);

        return {
          isSuccess: true,
          message: "Eval runs summary fetched successfully",
          summary: {
            chatbot: { publicId: chatbot.publicId, name: chatbot.name },
            caseCount: counted.caseCount ?? 0,
            safetyCaseCount: counted.safetyCaseCount ?? 0,
            live: published.chatbotConfig
              ? { configVersion: published.chatbotConfig.configVersion, run: itemOf(liveRun.run) }
              : null,
            draft: draft.chatbotConfig
              ? { configVersion: draft.chatbotConfig.configVersion, run: itemOf(draftRun.run) }
              : null,
            staging,
          },
        };
      },
    );
  }

  // DEV_NOTE: The run that stands for a config: its gate run (approved_by_run_id) when it has one, else its newest run;
  // null = never tested
  private async configRun(
    tx: Tx,
    companyId: string,
    config: Pick<Schemas.ChatbotConfig, "id" | "approvedByRunId">,
  ): Promise<{ isSuccess: true; run: Schemas.DashboardEvalRunRow | null } | Schemas.ApiResponse> {
    if (config.approvedByRunId !== null) {
      const approved = await this.evalRunsDal.getEvalRunById(tx, {
        companyId,
        id: config.approvedByRunId,
      });
      if (approved.isSuccess && approved.evalRun) return { isSuccess: true, run: approved.evalRun };
      if (!approved.isNotFound) return { isSuccess: false, message: approved.message };
    }
    const latest = await this.evalRunsDal.getLatestEvalRun(tx, {
      companyId,
      chatbotConfigId: config.id,
    });
    if (latest.isSuccess && latest.evalRun) return { isSuccess: true, run: latest.evalRun };
    if (latest.isNotFound) return { isSuccess: true, run: null };
    return { isSuccess: false, message: latest.message };
  }

  async getEvalRun(params: {
    companyId: string;
    publicId: string;
  }): Promise<Schemas.GetEvalRunApiResponse> {
    const { companyId } = params;
    return await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.GetEvalRunApiResponse> => {
        const found = await this.evalRunsDal.getEvalRun(tx, params);
        if (!found.isSuccess || !found.evalRun) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        const listed = await this.toListItems(tx, companyId, [found.evalRun]);
        if (!("items" in listed)) return listed;
        return {
          isSuccess: true,
          message: "Eval run fetched successfully",
          evalRun: listed.items[0],
        };
      },
    );
  }

  // DEV_NOTE: One run's cases with how many attempts passed (failed first by default), paged
  async getEvalRunCases(
    params: Schemas.GetEvalRunCasesApiRequest & { companyId: string; publicId: string },
  ): Promise<Schemas.GetEvalRunCasesApiResponse> {
    const { companyId } = params;
    return await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.GetEvalRunCasesApiResponse> => {
        const found = await this.evalRunsDal.getEvalRun(tx, {
          companyId,
          publicId: params.publicId,
        });
        if (!found.isSuccess || !found.evalRun) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        const run = found.evalRun;

        const page = await this.evalRunsDal.getEvalRunCases(tx, {
          companyId,
          evalRunId: run.id,
          k: run.k,
          isRunUnderway: Schemas.isEvalRunUnderway(run.status),
          pageNo: params.pageNo ?? Constants.DEFAULT_PAGE_NO,
          pageSize: params.pageSize ?? Constants.DEFAULT_PAGE_SIZE,
          sortColumn: params.sortColumn ?? Schemas.EvalRunCaseSortColumn.Result,
          sortDirection: params.sortDirection ?? Schemas.SortDirection.Asc,
        });
        if (!page.isSuccess) return { isSuccess: false, message: page.message };

        const counted = await this.evalRunsDal.getEvalRunCasesCount(tx, {
          companyId,
          evalRunId: run.id,
        });
        if (!counted.isSuccess) return { isSuccess: false, message: counted.message };

        return {
          isSuccess: true,
          message: "Eval run cases fetched successfully",
          cases: (page.cases ?? []).map((row) => ({
            evalCase: {
              publicId: row.evalCasePublicId,
              name: row.name,
              isSafety: row.isSafety,
              isPlatform: row.caseCompanyId === null,
            },
            attemptCount: row.attemptCount,
            passedAttemptCount: row.passedAttemptCount,
            hasPassed: Schemas.evalCaseRunResult({
              passedAttemptCount: row.passedAttemptCount,
              attemptCount: row.attemptCount,
              k: run.k,
              runStatus: run.status,
            }),
          })),
          totalRecords: counted.totalRecords ?? 0,
        };
      },
    );
  }

  // DEV_NOTE: One case's attempts in a run: what each check found (grader output through its parser) and where its
  // transcript is. Unknown run, or a case with no result in it → 404.
  async getEvalRunCase(params: {
    companyId: string;
    publicId: string;
    casePublicId: string;
  }): Promise<Schemas.GetEvalRunCaseApiResponse> {
    const { companyId } = params;
    return await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.GetEvalRunCaseApiResponse> => {
        const found = await this.evalRunsDal.getEvalRun(tx, {
          companyId,
          publicId: params.publicId,
        });
        if (!found.isSuccess || !found.evalRun) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        const run = found.evalRun;

        const listed = await this.evalRunsDal.getEvalRunCaseAttempts(tx, {
          companyId,
          evalRunId: run.id,
          evalCasePublicId: params.casePublicId,
        });
        if (!listed.isSuccess || !listed.attempts) {
          return { isSuccess: false, message: listed.message, isNotFound: listed.isNotFound };
        }
        const rows = listed.attempts;
        const [first] = rows;
        const passedAttemptCount = rows.filter((row) => row.hasPassed).length;

        return {
          isSuccess: true,
          message: "Eval run case fetched successfully",
          runCase: {
            evalCase: {
              publicId: first.evalCasePublicId,
              name: first.name,
              isSafety: first.isSafety,
              isPlatform: first.caseCompanyId === null,
            },
            attemptCount: rows.length,
            passedAttemptCount,
            hasPassed: Schemas.evalCaseRunResult({
              passedAttemptCount,
              attemptCount: rows.length,
              k: run.k,
              runStatus: run.status,
            }),
          },
          k: run.k,
          attempts: rows.map((row) => EvalRunsProvider.attempt(row)),
        };
      },
    );
  }

  // DEV_NOTE: An attempt's transcript: the file found in one withTenant (a transcript of a result of this run, else
  // 404), then read from R2 outside any transaction and parsed (parseEvalTranscript). A file too big, not JSON or not a
  // transcript → failure Unreadable (422); the bytes are never logged or returned.
  async getEvalRunTranscript(params: {
    companyId: string;
    publicId: string;
    filePublicId: string;
  }): Promise<Schemas.GetEvalTranscriptApiResponse> {
    const { companyId } = params;
    const logMetadata = {
      companyId,
      evalRunPublicId: params.publicId,
      filePublicId: params.filePublicId,
    };
    const located = await withTenant(this.db, companyId, async (tx): Promise<TranscriptKey> => {
      const run = await this.evalRunsDal.getEvalRun(tx, { companyId, publicId: params.publicId });
      if (!run.isSuccess || !run.evalRun) {
        return { isSuccess: false, message: run.message, isNotFound: run.isNotFound };
      }
      const file = await this.filesDal.getEvalRunTranscriptFile(tx, {
        companyId,
        publicId: params.filePublicId,
        evalRunId: run.evalRun.id,
      });
      if (!file.isSuccess || !file.file || !file.companyPublicId) {
        return { isSuccess: false, message: file.message, isNotFound: file.isNotFound };
      }
      return {
        isSuccess: true,
        key: Schemas.fileR2Key(file.companyPublicId, file.file.publicId),
        sizeBytes: file.file.sizeBytes,
      };
    });
    if (!located.isSuccess || !("key" in located)) return located;

    const unreadable = (reason: string): Schemas.GetEvalTranscriptApiResponse => {
      AppLogger.warn({
        category: Schemas.LogCategory.Repo,
        action: Schemas.LogAction.GetEvalRunTranscript,
        message: "Transcript unreadable",
        metadata: { ...logMetadata, reason },
      });
      return {
        isSuccess: false,
        message: "Transcript unreadable",
        failure: Schemas.EvalTranscriptFailureEnum.Unreadable,
      };
    };
    // DEV_NOTE: The registry's size is checked first, then the object's own size before its body is read (the row may be
    // wrong), and parseEvalTranscript checks the bytes
    if (located.sizeBytes > Schemas.EVAL_TRANSCRIPT_MAX_BYTES) return unreadable("too large");

    const object = await FileStorageProvider.getObject(this.env, {
      key: located.key,
      maxBytes: Schemas.EVAL_TRANSCRIPT_MAX_BYTES,
    });
    if (object.isTooLarge) return unreadable("too large");
    if (!object.isSuccess || !object.bytes) {
      return { isSuccess: false, message: object.message, isNotFound: object.isNotFound };
    }
    const transcript = Schemas.parseEvalTranscript(object.bytes);
    if (!transcript) return unreadable("not a transcript");

    return {
      isSuccess: true,
      message: "Transcript fetched successfully",
      transcript: { entries: EvalRunsProvider.transcriptView(transcript) },
    };
  }
}
