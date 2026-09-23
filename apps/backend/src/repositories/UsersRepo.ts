import UsersDAL from "@/data-access-layer/UsersDAL";
import type * as Schemas from "@app/schemas";

export default class UsersRepo {
  private dal: UsersDAL;

  constructor(env: Env) {
    this.dal = new UsersDAL(env);
  }

  async syncClerkUser(params: Schemas.SyncClerkUserApiRequest) {
    return await this.dal.upsertUser(params);
  }

  async getUserDetails(params: { clerkId: string }) {
    return await this.dal.getUserDetails({
      clerkId: params.clerkId,
    });
  }
}
