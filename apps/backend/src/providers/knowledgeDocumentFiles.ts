import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import * as Schemas from "@app/schemas";
import FilesDAL from "@/data-access-layer/FilesDAL";
import KnowledgeChunksDAL from "@/data-access-layer/KnowledgeChunksDAL";
import KnowledgeDocumentsDAL from "@/data-access-layer/KnowledgeDocumentsDAL";

// DEV_NOTE: A file row is created before its document because knowledge_documents.file_id is NOT NULL, then pointed at
// the document in the same transaction. No DB foreign keys, so nothing outside the transaction ever sees this.
const PENDING_OWNER_ID = "0";

// DEV_NOTE: A knowledge document's rows together with its file rows, shared by KnowledgeSourcesRepo (uploads, deletes)
// and KnowledgeIngestionRepo (sync, prune). Takes the Repo's withTenant tx, never opens one or touches R2 (provider →
// DAL). The Repo writes a new file's R2 object before the transaction (named by a publicId it generates, so no source
// lock is held while bytes upload) and deletes it if the transaction doesn't commit; objects of replaced or removed
// files are deleted after the commit. A file's bytes never change: new bytes are a new file. So a failure leaves at
// worst an object with no row, never a row whose object is missing or holds other bytes.
// Returns { isSuccess, message } and never throws.
export default class KnowledgeDocumentFilesProvider {
  private static filesDal = new FilesDAL();
  private static documentsDal = new KnowledgeDocumentsDAL();
  private static chunksDal = new KnowledgeChunksDAL();

  static async create(
    tx: NodePgTransaction<EmptyRelations>,
    params: {
      companyId: string;
      knowledgeSourceId: string;
      file: Pick<
        Schemas.StoredFile,
        "publicId" | "filename" | "mime" | "sizeBytes" | "sha256" | "createdBy"
      >;
      document: Pick<
        Schemas.KnowledgeDocument,
        "title" | "sourceUrl" | "contentHash" | "indexStatus" | "lastSyncedAt"
      >;
    },
  ): Promise<Schemas.CreateKnowledgeDocumentWithFileResponse> {
    const file = await KnowledgeDocumentFilesProvider.filesDal.createFile(tx, {
      ...params.file,
      companyId: params.companyId,
      ownerType: Schemas.FileOwnerTypeEnum.KnowledgeDocument,
      ownerId: PENDING_OWNER_ID,
    });
    if (!file.isSuccess || !file.file) {
      return { isSuccess: false, message: file.message };
    }

    const document = await KnowledgeDocumentFilesProvider.documentsDal.createKnowledgeDocument(tx, {
      companyId: params.companyId,
      knowledgeSourceId: params.knowledgeSourceId,
      fileId: file.file.id,
      ...params.document,
    });
    if (!document.isSuccess || !document.knowledgeDocument) {
      return { isSuccess: false, message: document.message };
    }

    const owned = await KnowledgeDocumentFilesProvider.filesDal.setFileOwner(tx, {
      id: file.file.id,
      companyId: params.companyId,
      ownerType: Schemas.FileOwnerTypeEnum.KnowledgeDocument,
      ownerId: document.knowledgeDocument.id,
    });
    if (!owned.isSuccess) {
      return { isSuccess: false, message: owned.message };
    }

    return {
      isSuccess: true,
      message: "Knowledge document created successfully",
      knowledgeDocument: document.knowledgeDocument,
    };
  }

  // DEV_NOTE: New bytes for an existing document (a re-synced page that changed): a new file row owned by the
  // document, and the old row deleted. The caller points the document at fileId in the same transaction and deletes
  // oldFileR2Key after the commit.
  static async replaceFile(
    tx: NodePgTransaction<EmptyRelations>,
    params: {
      companyId: string;
      companyPublicId: string;
      document: Schemas.KnowledgeDocument;
      file: Pick<Schemas.StoredFile, "publicId" | "mime" | "sizeBytes" | "sha256">;
    },
  ): Promise<Schemas.ReplaceKnowledgeDocumentFileResponse> {
    const file = await KnowledgeDocumentFilesProvider.filesDal.createFile(tx, {
      ...params.file,
      companyId: params.companyId,
      ownerType: Schemas.FileOwnerTypeEnum.KnowledgeDocument,
      ownerId: params.document.id,
      filename: null,
      createdBy: null,
    });
    if (!file.isSuccess || !file.file) {
      return { isSuccess: false, message: file.message };
    }

    const deleted = await KnowledgeDocumentFilesProvider.filesDal.deleteFiles(tx, {
      companyId: params.companyId,
      ids: [params.document.fileId],
    });
    if (!deleted.isSuccess || !deleted.files) {
      return { isSuccess: false, message: deleted.message };
    }

    const [oldFile] = deleted.files;
    return {
      isSuccess: true,
      message: "Knowledge document file replaced successfully",
      fileId: file.file.id,
      oldFileR2Key: oldFile
        ? Schemas.fileR2Key(params.companyPublicId, oldFile.publicId)
        : undefined,
    };
  }

  // DEV_NOTE: Deletes the documents' chunks, the documents and their file rows; returns the R2 keys to delete after
  // the commit
  static async remove(
    tx: NodePgTransaction<EmptyRelations>,
    params: {
      companyId: string;
      companyPublicId: string;
      documents: Schemas.KnowledgeDocument[];
    },
  ): Promise<Schemas.RemoveKnowledgeDocumentsResponse> {
    if (params.documents.length === 0) {
      return {
        isSuccess: true,
        message: "No knowledge documents to remove",
        deletedCount: 0,
        fileR2Keys: [],
      };
    }

    const chunks = await KnowledgeDocumentFilesProvider.chunksDal.deleteKnowledgeChunksByDocuments(
      tx,
      {
        companyId: params.companyId,
        knowledgeDocumentIds: params.documents.map((document) => document.id),
      },
    );
    if (!chunks.isSuccess) {
      return { isSuccess: false, message: chunks.message };
    }

    const documents = await KnowledgeDocumentFilesProvider.documentsDal.deleteKnowledgeDocuments(
      tx,
      {
        companyId: params.companyId,
        ids: params.documents.map((document) => document.id),
      },
    );
    if (!documents.isSuccess || !documents.knowledgeDocuments) {
      return { isSuccess: false, message: documents.message };
    }

    return await KnowledgeDocumentFilesProvider.removeFiles(tx, {
      ...params,
      documents: documents.knowledgeDocuments,
    });
  }

  // DEV_NOTE: Every document of a source (the source itself is deleted): chunks by source, documents by source, then
  // their file rows
  static async removeBySource(
    tx: NodePgTransaction<EmptyRelations>,
    params: { companyId: string; companyPublicId: string; knowledgeSourceId: string },
  ): Promise<Schemas.RemoveKnowledgeDocumentsResponse> {
    const chunks = await KnowledgeDocumentFilesProvider.chunksDal.deleteKnowledgeChunksBySource(
      tx,
      params,
    );
    if (!chunks.isSuccess) {
      return { isSuccess: false, message: chunks.message };
    }

    const documents =
      await KnowledgeDocumentFilesProvider.documentsDal.deleteKnowledgeDocumentsBySource(
        tx,
        params,
      );
    if (!documents.isSuccess || !documents.knowledgeDocuments) {
      return { isSuccess: false, message: documents.message };
    }

    return await KnowledgeDocumentFilesProvider.removeFiles(tx, {
      ...params,
      documents: documents.knowledgeDocuments,
    });
  }

  private static async removeFiles(
    tx: NodePgTransaction<EmptyRelations>,
    params: { companyId: string; companyPublicId: string; documents: Schemas.KnowledgeDocument[] },
  ): Promise<Schemas.RemoveKnowledgeDocumentsResponse> {
    const files = await KnowledgeDocumentFilesProvider.filesDal.deleteFiles(tx, {
      companyId: params.companyId,
      ids: params.documents.map((document) => document.fileId),
    });
    if (!files.isSuccess || !files.files) {
      return { isSuccess: false, message: files.message };
    }

    return {
      isSuccess: true,
      message: "Knowledge documents removed successfully",
      deletedCount: params.documents.length,
      fileR2Keys: files.files.map((file) =>
        Schemas.fileR2Key(params.companyPublicId, file.publicId),
      ),
    };
  }
}
