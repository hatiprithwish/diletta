import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import { toast } from "sonner";
import type * as Schemas from "@app/schemas";
import { apiClient } from "@/providers/apiClient";

type GetToken = Parameters<typeof apiClient>[1];

// DEV_NOTE: Settings › Budget (M4-10): the spending budget in force and this billing period's spend. A save's answer
// replaces it (setQueryData).
export class BudgetQueries {
  static keys = {
    all: () => ["budget"] as const,
    spendingBudget: () => [...BudgetQueries.keys.all(), "spending-budget"] as const,
  };

  static spendingBudget(getToken: GetToken) {
    return queryOptions({
      queryKey: BudgetQueries.keys.spendingBudget(),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetSpendingBudgetApiResponse>("/dashboard/settings/budget", getToken, {
          signal,
        }),
    });
  }
}

export function useSpendingBudget() {
  const { getToken } = useAuth();
  return useQuery(BudgetQueries.spendingBudget(getToken));
}

// DEV_NOTE: Awaited by the form (mutateAsync)
export function useUpdateSpendingBudget() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas.UpdateSpendingBudgetApiRequest) =>
      apiClient<Schemas.UpdateSpendingBudgetApiResponse>("/dashboard/settings/budget", getToken, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: (response) => {
      queryClient.setQueryData<Schemas.GetSpendingBudgetApiResponse>(
        BudgetQueries.keys.spendingBudget(),
        response,
      );
      toast.success("Budget saved. It applies within a minute.");
    },
    onError: () => {
      toast.error("The budget wasn't saved. Nothing changed, try again.");
    },
  });
}
