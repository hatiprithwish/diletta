import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";

// DEV_NOTE: R2 limits a delete call to this many keys
const R2_DELETE_BATCH_SIZE = 1000;

// DEV_NOTE: The R2 side of the files registry (FILES_BUCKET). Every object has a files row and lives at
// Schemas.fileR2Key(company public_id, file public_id); the Repo writes the row and the object together and deletes
// both. Returns { isSuccess, message } and never throws. Keys and sizes are logged, never the bytes.
export default class FileStorageProvider {
  static async putObject(
    env: Env,
    params: { key: string; bytes: Uint8Array<ArrayBuffer>; mime: string },
  ): Promise<Schemas.ApiResponse> {
    try {
      await env.FILES_BUCKET.put(params.key, params.bytes, {
        httpMetadata: { contentType: params.mime },
      });
      return { isSuccess: true, message: "File object stored successfully" };
    } catch (error) {
      const message = "Unknown error in storing file object";
      AppLogger.error({
        category: Schemas.LogCategory.Knowledge,
        action: Schemas.LogAction.PutFileObject,
        message,
        error,
        metadata: { key: params.key, sizeBytes: params.bytes.byteLength },
      });
      return { isSuccess: false, message };
    }
  }

  static async getObject(env: Env, params: { key: string }): Promise<Schemas.FileObjectResponse> {
    const response: Schemas.FileObjectResponse = { isSuccess: false };

    try {
      const object = await env.FILES_BUCKET.get(params.key);
      if (!object) {
        const message = "File object not found";
        AppLogger.error({
          category: Schemas.LogCategory.Knowledge,
          action: Schemas.LogAction.GetFileObject,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "File object fetched successfully";
      response.bytes = new Uint8Array(await object.arrayBuffer());
    } catch (error) {
      const message = "Unknown error in fetching file object";
      AppLogger.error({
        category: Schemas.LogCategory.Knowledge,
        action: Schemas.LogAction.GetFileObject,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Runs after the rows' transaction commits. A failure leaves an object with no row (logged with its keys
  // for cleanup), never a row with no object.
  static async deleteObjects(env: Env, params: { keys: string[] }): Promise<Schemas.ApiResponse> {
    try {
      for (let start = 0; start < params.keys.length; start += R2_DELETE_BATCH_SIZE) {
        await env.FILES_BUCKET.delete(params.keys.slice(start, start + R2_DELETE_BATCH_SIZE));
      }
      return { isSuccess: true, message: "File objects deleted successfully" };
    } catch (error) {
      const message = "Unknown error in deleting file objects";
      AppLogger.error({
        category: Schemas.LogCategory.Knowledge,
        action: Schemas.LogAction.DeleteFileObjects,
        message,
        error,
        metadata: { keys: params.keys },
      });
      return { isSuccess: false, message };
    }
  }
}
