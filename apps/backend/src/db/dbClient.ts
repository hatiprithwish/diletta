import { drizzle } from "drizzle-orm/d1";

export default function getDbClient(env: Env) {
  return drizzle(env.DB);
}
