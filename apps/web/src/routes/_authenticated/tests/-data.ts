import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import { toast } from "sonner";
import * as Schemas from "@app/schemas";
import { ApiError, apiClient } from "@/providers/apiClient";
import { QUERY_KEY_ROOTS, TESTS_KEY_SEGMENTS } from "../-invalidation";

type GetToken = Parameters<typeof apiClient>[1];

// DEV_NOTE: The Tests page (M4-8): the metric strip, the runs, one run's cases, one case's attempts, an attempt's
// transcript, and the cases with New case / Edit / on-off. keys.all() covers them all. A transcript never changes, so
// it is never refetched. Runs start from the CLI or, since M7-9, from Run tests / Run again (useStartTestRun); while a
// run is Queued or Running, what shows it is refetched every RUN_POLL_MS until it ends.
const RUN_POLL_MS = 10_000;

const isRunGoing = (status: Schemas.EvalRunStatusIntEnum | undefined) =>
  status === Schemas.EvalRunStatusIntEnum.Queued || status === Schemas.EvalRunStatusIntEnum.Running;

const pollWhile = (isGoing: boolean) => (isGoing ? RUN_POLL_MS : false);
export class TestsQueries {
  static keys = {
    all: () => QUERY_KEY_ROOTS.tests,
    summary: () => [...TestsQueries.keys.all(), TESTS_KEY_SEGMENTS.summary] as const,
    runs: () => [...TestsQueries.keys.all(), "runs"] as const,
    runList: (page: number) => [...TestsQueries.keys.runs(), page] as const,
    run: (publicId: string) => [...TestsQueries.keys.all(), "run", publicId] as const,
    runCases: (publicId: string, page: number) =>
      [...TestsQueries.keys.run(publicId), "cases", page] as const,
    runCase: (publicId: string, casePublicId: string) =>
      [...TestsQueries.keys.run(publicId), "case", casePublicId] as const,
    transcript: (publicId: string, filePublicId: string) =>
      [...TestsQueries.keys.run(publicId), "transcript", filePublicId] as const,
    cases: () => [...TestsQueries.keys.all(), TESTS_KEY_SEGMENTS.cases] as const,
    caseList: (page: number) => [...TestsQueries.keys.cases(), page] as const,
    details: () => [...TestsQueries.keys.all(), "detail"] as const,
    caseDetail: (publicId: string) => [...TestsQueries.keys.details(), publicId] as const,
  };

  static summary(getToken: GetToken) {
    return queryOptions({
      queryKey: TestsQueries.keys.summary(),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetEvalRunsSummaryApiResponse>("/dashboard/eval-runs/summary", getToken, {
          signal,
        }),
      refetchInterval: (query) => {
        const summary = query.state.data?.summary;
        return pollWhile(
          isRunGoing(summary?.live?.run?.evalRunStatus) ||
            isRunGoing(summary?.draft?.run?.evalRunStatus),
        );
      },
    });
  }

  static runList(page: number, getToken: GetToken) {
    const params = new URLSearchParams({
      pageNo: String(page),
      pageSize: String(Schemas.EVAL_RUNS_PAGE_SIZE),
    });
    return queryOptions({
      queryKey: TestsQueries.keys.runList(page),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetEvalRunsApiResponse>(
          `/dashboard/eval-runs?${params.toString()}`,
          getToken,
          { signal },
        ),
      placeholderData: keepPreviousData,
      refetchInterval: (query) =>
        pollWhile((query.state.data?.evalRuns ?? []).some((run) => isRunGoing(run.evalRunStatus))),
    });
  }

  static run(publicId: string, getToken: GetToken) {
    return queryOptions({
      queryKey: TestsQueries.keys.run(publicId),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetEvalRunApiResponse>(
          `/dashboard/eval-runs/${encodeURIComponent(publicId)}`,
          getToken,
          { signal },
        ),
      refetchInterval: (query) => pollWhile(isRunGoing(query.state.data?.evalRun?.evalRunStatus)),
    });
  }

  // DEV_NOTE: isRunning = the run is still Queued or Running: its cases fill in as attempts are graded
  static runCases(publicId: string, page: number, getToken: GetToken, isRunning = false) {
    const params = new URLSearchParams({
      pageNo: String(page),
      pageSize: String(Schemas.EVAL_RUN_CASES_PAGE_SIZE),
    });
    return queryOptions({
      queryKey: TestsQueries.keys.runCases(publicId, page),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetEvalRunCasesApiResponse>(
          `/dashboard/eval-runs/${encodeURIComponent(publicId)}/cases?${params.toString()}`,
          getToken,
          { signal },
        ),
      placeholderData: keepPreviousData,
      refetchInterval: pollWhile(isRunning),
    });
  }

  static runCase(publicId: string, casePublicId: string, getToken: GetToken) {
    return queryOptions({
      queryKey: TestsQueries.keys.runCase(publicId, casePublicId),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetEvalRunCaseApiResponse>(
          `/dashboard/eval-runs/${encodeURIComponent(publicId)}/cases/${encodeURIComponent(casePublicId)}`,
          getToken,
          { signal },
        ),
    });
  }

  static transcript(publicId: string, filePublicId: string, getToken: GetToken) {
    return queryOptions({
      queryKey: TestsQueries.keys.transcript(publicId, filePublicId),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetEvalTranscriptApiResponse>(
          `/dashboard/eval-runs/${encodeURIComponent(publicId)}/transcripts/${encodeURIComponent(filePublicId)}`,
          getToken,
          { signal },
        ),
      staleTime: Infinity,
    });
  }

  static caseList(page: number, getToken: GetToken) {
    const params = new URLSearchParams({
      pageNo: String(page),
      pageSize: String(Schemas.EVAL_CASES_PAGE_SIZE),
    });
    return queryOptions({
      queryKey: TestsQueries.keys.caseList(page),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetEvalCasesApiResponse>(
          `/dashboard/eval-cases?${params.toString()}`,
          getToken,
          { signal },
        ),
      placeholderData: keepPreviousData,
    });
  }

  static caseDetail(publicId: string, getToken: GetToken) {
    return queryOptions({
      queryKey: TestsQueries.keys.caseDetail(publicId),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetEvalCaseApiResponse>(
          `/dashboard/eval-cases/${encodeURIComponent(publicId)}`,
          getToken,
          { signal },
        ),
    });
  }
}

export function useTestsSummary() {
  const { getToken } = useAuth();
  return useQuery(TestsQueries.summary(getToken));
}

export function useTestRuns(page: number) {
  const { getToken } = useAuth();
  return useQuery(TestsQueries.runList(page, getToken));
}

export function useTestRun(publicId: string) {
  const { getToken } = useAuth();
  return useQuery(TestsQueries.run(publicId, getToken));
}

export function useTestRunCases(publicId: string, page: number, isRunning = false) {
  const { getToken } = useAuth();
  return useQuery(TestsQueries.runCases(publicId, page, getToken, isRunning));
}

export function useTestRunCase(publicId: string, casePublicId: string) {
  const { getToken } = useAuth();
  return useQuery(TestsQueries.runCase(publicId, casePublicId, getToken));
}

// DEV_NOTE: Read only while the sheet is open (filePublicId set)
export function useTestTranscript(publicId: string, filePublicId: string | null) {
  const { getToken } = useAuth();
  return useQuery({
    ...TestsQueries.transcript(publicId, filePublicId ?? "", getToken),
    enabled: filePublicId !== null,
  });
}

export function useTestCases(page: number) {
  const { getToken } = useAuth();
  return useQuery(TestsQueries.caseList(page, getToken));
}

// DEV_NOTE: Read only while a case is being edited (publicId set)
export function useTestCase(publicId: string | null) {
  const { getToken } = useAuth();
  return useQuery({
    ...TestsQueries.caseDetail(publicId ?? "", getToken),
    enabled: publicId !== null,
  });
}

// DEV_NOTE: After a case write: its detail shows the answer at once; the case lists and the strip's counts refetch
function applyCaseWrite(queryClient: QueryClient, response: Schemas.WriteEvalCaseApiResponse) {
  const { evalCase } = response;
  if (evalCase) {
    queryClient.setQueryData<Schemas.GetEvalCaseApiResponse>(
      TestsQueries.keys.caseDetail(evalCase.publicId),
      { isSuccess: true, evalCase },
    );
  }
  void queryClient.invalidateQueries({ queryKey: TestsQueries.keys.cases() });
  void queryClient.invalidateQueries({ queryKey: TestsQueries.keys.summary() });
}

// DEV_NOTE: New case, for the company's default chatbot. The dialog awaits it (mutateAsync) and closes on success.
export function useCreateTestCase() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas.CreateEvalCaseApiRequest) =>
      apiClient<Schemas.WriteEvalCaseApiResponse>("/dashboard/eval-cases", getToken, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (response) => {
      applyCaseWrite(queryClient, response);
      toast.success("Case saved.");
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        toast.error("Add a chatbot before writing test cases. Nothing was saved.");
        return;
      }
      toast.error("The case wasn't saved. Nothing changed, try again.");
    },
  });
}

// DEV_NOTE: Edit, or turn a case on or off (the company's own cases only)
export function useUpdateTestCase(publicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas.UpdateEvalCaseApiRequest) =>
      apiClient<Schemas.WriteEvalCaseApiResponse>(
        `/dashboard/eval-cases/${encodeURIComponent(publicId)}`,
        getToken,
        { method: "PATCH", body: JSON.stringify(body) },
      ),
    onSuccess: (response, body) => {
      applyCaseWrite(queryClient, response);
      if (body.isActive !== undefined) {
        toast.success(body.isActive ? "Case turned on." : "Case turned off.");
      } else {
        toast.success("Case saved.");
      }
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        const failure = (error.body as Schemas.WriteEvalCaseApiResponse).failure;
        toast.error(
          failure === Schemas.EvalCaseUpdateFailureEnum.NothingToCheck
            ? "This case needs something to check. Say what a good reply does. Nothing changed."
            : "This case's conversation can't be edited here. Nothing changed.",
        );
        return;
      }
      if (
        error instanceof ApiError &&
        (error.body as Schemas.WriteEvalCaseApiResponse).failure ===
          Schemas.EvalCaseUpdateFailureEnum.TooLong
      ) {
        toast.error(
          "This case is too long to save. Shorten what a good reply does. Nothing changed.",
        );
        return;
      }
      if (error instanceof ApiError && error.status === 404) {
        void queryClient.invalidateQueries({ queryKey: TestsQueries.keys.cases() });
        toast.error("This case isn't available. It may have been removed.");
        return;
      }
      toast.error("The case wasn't saved. Nothing changed, try again.");
    },
  });
}

// DEV_NOTE: Run tests / Run again (M7-9): queues a run of one version on the hosted runner. The runs and the summary
// are refetched so the Queued run shows at once (and polls). A refusal says why in words: another run of the version
// still going, a version no longer in testing, no test sign-in, or the runner unavailable (the run is then Failed).
export function useStartTestRun() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas.StartEvalRunApiRequest) =>
      apiClient<Schemas.StartEvalRunApiResponse>("/dashboard/eval-runs", getToken, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (_response, body) => {
      void queryClient.invalidateQueries({ queryKey: TestsQueries.keys.all() });
      toast.success(
        body.trigger === Schemas.EvalRunTriggerIntEnum.Gate
          ? "Tests started. The version is ready to publish if they pass."
          : "Tests started.",
      );
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: TestsQueries.keys.all() });
      const failure =
        error instanceof ApiError
          ? (error.body as Schemas.StartEvalRunApiResponse | undefined)?.failure
          : undefined;
      switch (failure) {
        case Schemas.EvalRunStartFailureEnum.AlreadyRunning:
          toast.error("This version's tests are already running.");
          return;
        case Schemas.EvalRunStartFailureEnum.NotTesting:
          toast.error("This version isn't in testing any more. Nothing was started.");
          return;
        case Schemas.EvalRunStartFailureEnum.NoTestLogin:
          toast.error(
            "Tests can't run yet: your staging environment has no test sign-in. Ask Diletta to set one up.",
          );
          return;
        case Schemas.EvalRunStartFailureEnum.RunnerUnavailable:
          toast.error("The test runner couldn't take the run. Try again in a minute.");
          return;
        case Schemas.EvalRunStartFailureEnum.NothingToRun:
          toast.error("That run has no failed case left to run.");
          return;
        default:
          toast.error("The tests didn't start. Try again.");
      }
    },
  });
}

// DEV_NOTE: Resume (ADR 0007 › Resume): the same run, its results kept, picked up by the runner where it stopped
export function useResumeTestRun() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runPublicId: string) =>
      apiClient<Schemas.StartEvalRunApiResponse>(
        `/dashboard/eval-runs/${encodeURIComponent(runPublicId)}/resume`,
        getToken,
        { method: "POST" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TestsQueries.keys.all() });
      toast.success("Tests resumed. Only the attempts without a result run.");
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: TestsQueries.keys.all() });
      const failure =
        error instanceof ApiError
          ? (error.body as Schemas.StartEvalRunApiResponse | undefined)?.failure
          : undefined;
      switch (failure) {
        case Schemas.EvalRunStartFailureEnum.AlreadyRunning:
          toast.error("This version's tests are already running.");
          return;
        case Schemas.EvalRunStartFailureEnum.NotResumable:
          toast.error("This run can't be resumed. Run the tests again instead.");
          return;
        case Schemas.EvalRunStartFailureEnum.NotTesting:
          toast.error(
            "This version isn't in testing any more. Send it to testing and run its tests again.",
          );
          return;
        case Schemas.EvalRunStartFailureEnum.NoTestLogin:
          toast.error(
            "Tests can't run yet: your staging environment has no test sign-in. Ask Diletta to set one up.",
          );
          return;
        case Schemas.EvalRunStartFailureEnum.RunnerUnavailable:
          toast.error("The test runner couldn't take the run. Try again in a minute.");
          return;
        default:
          toast.error("The run didn't resume. Try again.");
      }
    },
  });
}
