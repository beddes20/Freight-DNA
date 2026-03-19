import { useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Paperclip, Download, FileText, FileSpreadsheet, X, Trash2, ZoomIn } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const MAX_FILE_SIZE = 10 * 1024 * 1024;

const ACCEPTED_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
].join(",");

function fileIcon(mimeType: string) {
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel") || mimeType === "text/csv")
    return <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />;
  return <FileText className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />;
}

interface AttachmentMeta {
  id: string;
  entityType: string;
  entityId: string;
  fileName: string;
  mimeType: string;
  createdAt: string;
}

interface PendingFile {
  file: File;
  base64: string;
}

interface FileAttachmentUploadProps {
  pendingFiles: PendingFile[];
  onAdd: (files: PendingFile[]) => void;
  onRemove: (index: number) => void;
  compact?: boolean;
}

export function FileAttachmentUpload({ pendingFiles, onAdd, onRemove, compact }: FileAttachmentUploadProps) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    const results: PendingFile[] = [];
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        toast({ title: `"${file.name}" is too large (max 10MB)`, variant: "destructive" });
        continue;
      }
      const base64 = await fileToBase64(file);
      results.push({ file, base64 });
    }
    if (results.length > 0) onAdd(results);
    if (inputRef.current) inputRef.current.value = "";
  };

  const imagePreviews = pendingFiles.filter(pf => pf.file.type.startsWith("image/"));
  const nonImageFiles = pendingFiles.filter(pf => !pf.file.type.startsWith("image/"));
  const imagePendingIndexes = pendingFiles
    .map((pf, i) => ({ pf, i }))
    .filter(({ pf }) => pf.file.type.startsWith("image/"));
  const nonImageIndexes = pendingFiles
    .map((pf, i) => ({ pf, i }))
    .filter(({ pf }) => !pf.file.type.startsWith("image/"));

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_TYPES}
          multiple
          onChange={handleFileSelect}
          className="hidden"
          data-testid="input-file-attachment"
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={compact ? "h-7 text-xs gap-1 px-2" : "h-8 text-xs gap-1.5"}
          onClick={() => inputRef.current?.click()}
          data-testid="button-attach-file"
        >
          <Paperclip className="h-3.5 w-3.5" />
          Attach
        </Button>
      </div>

      {imagePendingIndexes.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {imagePendingIndexes.map(({ pf, i }) => (
            <div key={i} className="relative group" data-testid={`pending-file-${i}`}>
              <img
                src={`data:${pf.file.type};base64,${pf.base64}`}
                alt={pf.file.name}
                className="h-20 w-28 object-cover rounded-md border border-border"
              />
              <button
                type="button"
                onClick={() => onRemove(i)}
                className="absolute top-1 right-1 bg-black/60 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                data-testid={`button-remove-pending-${i}`}
              >
                <X className="h-3 w-3" />
              </button>
              <span className="absolute bottom-0 left-0 right-0 text-[9px] text-white bg-black/50 px-1 py-0.5 rounded-b-md truncate">{pf.file.name}</span>
            </div>
          ))}
        </div>
      )}

      {nonImageIndexes.length > 0 && (
        <div className="space-y-1">
          {nonImageIndexes.map(({ pf, i }) => (
            <div
              key={i}
              className="flex items-center gap-2 text-xs bg-muted/50 rounded px-2 py-1.5"
              data-testid={`pending-file-${i}`}
            >
              {fileIcon(pf.file.type)}
              <span className="truncate flex-1">{pf.file.name}</span>
              <span className="text-muted-foreground shrink-0">
                {(pf.file.size / 1024).toFixed(0)}KB
              </span>
              <button
                type="button"
                onClick={() => onRemove(i)}
                className="text-muted-foreground hover:text-destructive shrink-0"
                data-testid={`button-remove-pending-${i}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface FileAttachmentListProps {
  entityType: string;
  entityIds: string[];
  showForEntityId?: string;
}

export function FileAttachmentList({ entityType, entityIds, showForEntityId }: FileAttachmentListProps) {
  const { toast } = useToast();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  const { data: allAttachments = [] } = useQuery<AttachmentMeta[]>({
    queryKey: ["/api/attachments", entityType, entityIds.join(",")],
    queryFn: async () => {
      if (entityIds.length === 0) return [];
      const res = await fetch(
        `/api/attachments?entityType=${entityType}&entityIds=${entityIds.join(",")}`,
        { credentials: "include" }
      );
      if (!res.ok) return [];
      return res.json();
    },
    enabled: entityIds.length > 0,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/attachments/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/attachments"] });
      setConfirmDelete(null);
      toast({ title: "Attachment deleted" });
    },
    onError: () => toast({ title: "Failed to delete attachment", variant: "destructive" }),
  });

  const attachments = showForEntityId
    ? allAttachments.filter(a => a.entityId === showForEntityId)
    : allAttachments;

  if (attachments.length === 0) return null;

  const images = attachments.filter(a => a.mimeType.startsWith("image/"));
  const nonImages = attachments.filter(a => !a.mimeType.startsWith("image/"));

  return (
    <>
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-4"
          onClick={() => setLightboxSrc(null)}
          data-testid="image-lightbox"
        >
          <img
            src={lightboxSrc}
            alt="Full size preview"
            className="max-h-[90vh] max-w-full rounded-lg shadow-2xl object-contain"
            onClick={e => e.stopPropagation()}
          />
          <button
            className="absolute top-4 right-4 text-white/80 hover:text-white bg-black/50 rounded-full p-2"
            onClick={() => setLightboxSrc(null)}
            data-testid="button-close-lightbox"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      )}

      <div className="space-y-2 mt-1" data-testid="attachment-list">
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {images.map(att => (
              <div key={att.id} className="relative group" data-testid={`attachment-img-${att.id}`}>
                <img
                  src={`/api/attachments/${att.id}/download`}
                  alt={att.fileName}
                  className="h-24 w-32 object-cover rounded-md border border-border cursor-pointer hover:opacity-90 transition-opacity"
                  onClick={() => setLightboxSrc(`/api/attachments/${att.id}/download`)}
                />
                <button
                  className="absolute top-1 left-1 bg-black/60 text-white/80 hover:text-white rounded p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => setLightboxSrc(`/api/attachments/${att.id}/download`)}
                  title="View full size"
                  data-testid={`button-view-img-${att.id}`}
                >
                  <ZoomIn className="h-3 w-3" />
                </button>
                {confirmDelete === att.id ? (
                  <div className="absolute top-1 right-1 flex items-center gap-0.5 bg-black/70 rounded px-1">
                    <button
                      className="text-[10px] text-red-400 hover:text-red-300 px-0.5 font-medium"
                      onClick={() => deleteMutation.mutate(att.id)}
                      disabled={deleteMutation.isPending}
                      data-testid={`button-confirm-delete-attachment-${att.id}`}
                    >
                      Del
                    </button>
                    <button
                      className="text-[10px] text-white/60 hover:text-white px-0.5"
                      onClick={() => setConfirmDelete(null)}
                      data-testid={`button-cancel-delete-attachment-${att.id}`}
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <button
                    className="absolute top-1 right-1 bg-black/60 text-white/80 hover:text-red-400 rounded p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => setConfirmDelete(att.id)}
                    title="Delete"
                    data-testid={`button-delete-attachment-${att.id}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {nonImages.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {nonImages.map(att => (
              <div key={att.id} className="inline-flex items-center gap-0.5 bg-muted/60 hover:bg-muted rounded-md border transition-colors group">
                <a
                  href={`/api/attachments/${att.id}/download`}
                  className="inline-flex items-center gap-1.5 text-xs px-2 py-1"
                  title={`Download ${att.fileName}`}
                  data-testid={`attachment-download-${att.id}`}
                >
                  {fileIcon(att.mimeType)}
                  <span className="truncate max-w-[140px]">{att.fileName}</span>
                  <Download className="h-3 w-3 text-muted-foreground shrink-0" />
                </a>
                {confirmDelete === att.id ? (
                  <div className="flex items-center gap-0.5 pr-1">
                    <button
                      className="text-xs text-red-600 hover:text-red-700 px-1 py-0.5 font-medium"
                      onClick={() => deleteMutation.mutate(att.id)}
                      disabled={deleteMutation.isPending}
                      data-testid={`button-confirm-delete-attachment-${att.id}`}
                    >
                      Delete
                    </button>
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground px-1 py-0.5"
                      onClick={() => setConfirmDelete(null)}
                      data-testid={`button-cancel-delete-attachment-${att.id}`}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    className="opacity-0 group-hover:opacity-100 p-1 text-muted-foreground hover:text-red-600 transition-all"
                    onClick={() => setConfirmDelete(att.id)}
                    title="Delete attachment"
                    data-testid={`button-delete-attachment-${att.id}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export async function uploadPendingFiles(
  pendingFiles: PendingFile[],
  entityType: string,
  entityId: string
): Promise<void> {
  const concurrency = 3;
  for (let i = 0; i < pendingFiles.length; i += concurrency) {
    const batch = pendingFiles.slice(i, i + concurrency);
    await Promise.all(
      batch.map((pf) =>
        apiRequest("POST", "/api/attachments", {
          entityType,
          entityId,
          fileName: pf.file.name,
          mimeType: pf.file.type,
          fileData: pf.base64,
        })
      )
    );
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export { fileToBase64 };
export type { PendingFile, AttachmentMeta };
