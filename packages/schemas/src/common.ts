export interface ApiResponse {
  isSuccess: boolean;
  message?: string;
}

export type NullableDALFields<T> = {
  [K in keyof T]: T[K] | null;
};
