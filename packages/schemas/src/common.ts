import { z } from "zod";

// DEV_NOTE: A bytea column. pg reads it as a Node Buffer, whose ArrayBuffer may be shared, so the type keeps
// ArrayBufferLike (z.instanceof(Uint8Array) would narrow it to ArrayBuffer and reject a Buffer).
export const ZBytes = z.custom<Uint8Array>((value) => value instanceof Uint8Array, {
  message: "Must be bytes",
});

export interface ApiResponse {
  isSuccess: boolean;
  message?: string;
}

export type NullableDALFields<T> = {
  [K in keyof T]: T[K] | null;
};

export enum SortDirection {
  Asc = "asc",
  Desc = "desc",
}

export const ZSortDirection = z.enum(SortDirection);

// DEV_NOTE: Upper bound on one page, so a client can't turn a paged list back into a full table read
export const MAX_PAGE_SIZE = 100;

// DEV_NOTE: Page-number pagination for lists that grow without bound. Every field is optional; the Repo fills
// the defaults. A list request extends this with its own sortColumn enum.
export const ZPageApiRequest = z.object({
  pageNo: z.number().int().min(1).nullable().optional(),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).nullable().optional(),
  sortDirection: ZSortDirection.nullable().optional(),
});
export type PageApiRequest = z.infer<typeof ZPageApiRequest>;

// DEV_NOTE: DAL side of a page: every field resolved by the Repo, nothing optional
export type PageDALRequest = {
  pageNo: number;
  pageSize: number;
  sortDirection: SortDirection;
};

// Count of every row a paged list can reach, for the page count in the UI
export interface TotalRecordsResponse extends ApiResponse {
  totalRecords?: number;
}
