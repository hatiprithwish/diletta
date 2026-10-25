import type { QueryClient } from "@tanstack/react-query";

// DEV_NOTE: The root query key of each dashboard page whose numbers several pages change. Each page's Queries class
// builds its keys.all() from its root here, so a page can refresh another without importing its data layer (no import
// cycles between pages).
export const QUERY_KEY_ROOTS = {
  overview: ["insights", "overview"],
  conversations: ["conversations"],
  quality: ["quality"],
  tests: ["tests"],
  security: ["security"],
} as const;

// DEV_NOTE: The Tests page's key segments that another page refreshes (TestsQueries.keys builds its keys from them)
export const TESTS_KEY_SEGMENTS = { cases: "cases", summary: "summary" } as const;

// DEV_NOTE: The key segment after a root that holds one record's detail (keys.details() on each page)
const DETAIL_KEY_SEGMENT = "detail";

// DEV_NOTE: Open quality issues changed (one opened by a flag, or closed or converted on the Quality page): every view
// that counts them refetches: Overview's Needs attention, the Conversations' lists and tab counts, and the Quality
// lists with the badge. Details are left out: the caller already set the one it changed (setQueryData).
export function invalidateOpenIssueViews(queryClient: QueryClient) {
  const roots = [QUERY_KEY_ROOTS.overview, QUERY_KEY_ROOTS.conversations, QUERY_KEY_ROOTS.quality];
  for (const root of roots) {
    void queryClient.invalidateQueries({
      queryKey: root,
      predicate: (query) => query.queryKey[root.length] !== DETAIL_KEY_SEGMENT,
    });
  }
}

// DEV_NOTE: A test case was added outside the Tests page (Quality's Create test, M4-6): the Tests page's case list and
// metric strip refetch
export function invalidateTestCaseViews(queryClient: QueryClient) {
  void queryClient.invalidateQueries({
    queryKey: [...QUERY_KEY_ROOTS.tests, TESTS_KEY_SEGMENTS.cases],
  });
  void queryClient.invalidateQueries({
    queryKey: [...QUERY_KEY_ROOTS.tests, TESTS_KEY_SEGMENTS.summary],
  });
}
