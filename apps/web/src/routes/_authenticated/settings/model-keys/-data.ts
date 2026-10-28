import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import { toast } from "sonner";
import * as Schemas from "@app/schemas";
import { ApiError, apiClient } from "@/providers/apiClient";
import { invalidateModelKeyViews } from "../../-invalidation";

type GetToken = Parameters<typeof apiClient>[1];

// DEV_NOTE: Settings › Model keys (M4-10): the company's model keys. A write's answer replaces its row in the list
// (setQueryData) and the draft editor's pickers refetch (invalidateModelKeyViews). A key's value is sent once, in the
// write, and never comes back.
export class ModelKeysQueries {
  static keys = {
    all: () => ["model-keys"] as const,
    list: () => [...ModelKeysQueries.keys.all(), "list"] as const,
  };

  static list(getToken: GetToken) {
    return queryOptions({
      queryKey: ModelKeysQueries.keys.list(),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetModelKeysApiResponse>("/dashboard/settings/model-keys", getToken, {
          signal,
        }),
    });
  }
}

export function useModelKeys() {
  const { getToken } = useAuth();
  return useQuery(ModelKeysQueries.list(getToken));
}

// DEV_NOTE: Why the provider check or the one-key rule refused a key (400 / 502 / 409 with its failure), for the dialog to
// show; null for any other error
export function modelKeyRefusalOf(error: unknown): Schemas.ModelKeyFailureEnum | null {
  if (!(error instanceof ApiError)) return null;
  return (error.body as Schemas.ModelKeyWriteApiResponse).failure ?? null;
}

// DEV_NOTE: The words for each refusal, shown in the dialog and the toast
export const MODEL_KEY_REFUSAL_COPY: Record<Schemas.ModelKeyFailureEnum, string> = {
  [Schemas.ModelKeyFailureEnum.KeyRejected]:
    "The provider rejected this key. Check it and paste it again.",
  [Schemas.ModelKeyFailureEnum.CheckUnavailable]:
    "The provider couldn't be reached to check this key. Nothing was saved, try again.",
  [Schemas.ModelKeyFailureEnum.ProviderHasActiveKey]:
    "This provider already has a working key. Rotate that key instead.",
};

function applyModelKeyWrite(queryClient: QueryClient, response: Schemas.ModelKeyWriteApiResponse) {
  const { modelKey } = response;
  if (modelKey) {
    queryClient.setQueryData<Schemas.GetModelKeysApiResponse>(
      ModelKeysQueries.keys.list(),
      (previous) => {
        if (!previous?.modelKeys) return previous;
        const isListed = previous.modelKeys.some((key) => key.publicId === modelKey.publicId);
        return {
          ...previous,
          modelKeys: isListed
            ? previous.modelKeys.map((key) => (key.publicId === modelKey.publicId ? modelKey : key))
            : [...previous.modelKeys, modelKey],
        };
      },
    );
  }
  invalidateModelKeyViews(queryClient);
}

function toastModelKeyError(queryClient: QueryClient, error: unknown, fallback: string) {
  const refusal = modelKeyRefusalOf(error);
  if (refusal) {
    toast.error(MODEL_KEY_REFUSAL_COPY[refusal]);
    return;
  }
  if (error instanceof ApiError && error.status === 404) {
    void queryClient.invalidateQueries({ queryKey: ModelKeysQueries.keys.all() });
    toast.error("This key isn't available. It may have been removed.");
    return;
  }
  toast.error(`${fallback} Nothing changed, try again.`);
}

// DEV_NOTE: Awaited by the dialog (mutateAsync), which closes on success and shows a refusal inline
export function useAddModelKey() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas.AddModelKeyApiRequest) =>
      apiClient<Schemas.ModelKeyWriteApiResponse>("/dashboard/settings/model-keys", getToken, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (response) => {
      applyModelKeyWrite(queryClient, response);
      toast.success(`${response.modelKey?.providerLabel ?? "Model"} key added and checked.`);
    },
    onError: (error) => toastModelKeyError(queryClient, error, "The key wasn't added."),
  });
}

export function useRotateModelKey(publicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas.RotateModelKeyApiRequest) =>
      apiClient<Schemas.ModelKeyWriteApiResponse>(
        `/dashboard/settings/model-keys/${encodeURIComponent(publicId)}/rotate`,
        getToken,
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: (response) => {
      applyModelKeyWrite(queryClient, response);
      toast.success("Key rotated. The assistant uses the new key from the next call.");
    },
    onError: (error) => toastModelKeyError(queryClient, error, "The key wasn't rotated."),
  });
}
