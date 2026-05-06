import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Upload, FileSpreadsheet } from "lucide-react";
import * as XLSX from "xlsx";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface ImportContactsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
}

export function ImportContactsDialog({ open, onOpenChange, companyId }: ImportContactsDialogProps) {
  const { toast } = useToast();
  const [importRows, setImportRows] = useState<any[]>([]);
  const [importFileName, setImportFileName] = useState("");

  const close = () => {
    setImportRows([]);
    setImportFileName("");
    onOpenChange(false);
  };

  const bulkImportMutation = useMutation({
    mutationFn: async (rows: any[]) => {
      const res = await apiRequest("POST", `/api/companies/${companyId}/contacts/bulk-import`, { contacts: rows });
      return res;
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      toast({ title: `Imported ${data.count} contact${data.count !== 1 ? "s" : ""}`, description: "Contacts have been added to this account." });
      close();
    },
    onError: (error: Error) => {
      toast({ title: "Import failed", description: error.message, variant: "destructive" });
    },
  });

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const data = ev.target?.result;
      const wb = XLSX.read(data, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw: any[] = XLSX.utils.sheet_to_json(ws, { defval: "" });
      const normalized = raw.map(r => {
        const keys = Object.keys(r);
        const find = (candidates: string[]) => {
          for (const c of candidates) {
            const k = keys.find(k => k.toLowerCase().replace(/[\s_-]/g, "").includes(c.toLowerCase().replace(/[\s_-]/g, "")));
            if (k && r[k]) return String(r[k]).trim();
          }
          return "";
        };
        return {
          name: find(["name", "fullname", "contactname", "contact"]),
          title: find(["title", "jobtitle", "position", "role"]),
          email: find(["email", "emailaddress", "mail"]),
          phone: find(["phone", "phonenumber", "mobile", "cell", "telephone"]),
          notes: find(["notes", "note", "comments", "comment"]),
          nextSteps: find(["nextsteps", "nextstep", "next steps", "next step", "action"]),
        };
      }).filter(r => r.name.length > 0);
      setImportRows(normalized);
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) close(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 text-green-600" />
            Import Contacts from Excel
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {importRows.length === 0 ? (
            <div className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-8 text-center">
              <Upload className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm font-medium mb-1">Drop your spreadsheet here or click to browse</p>
              <p className="text-xs text-muted-foreground mb-4">Supports .xlsx, .xls, and .csv files. Columns detected automatically: Name, Title, Email, Phone, Notes.</p>
              <label className="cursor-pointer">
                <Button variant="outline" size="sm" asChild>
                  <span><Upload className="h-4 w-4 mr-2" />Choose File</span>
                </Button>
                <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportFile} data-testid="input-import-contacts-file" />
              </label>
              {importFileName && <p className="text-xs text-muted-foreground mt-2">{importFileName}</p>}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">{importRows.length} contacts found in <span className="font-medium text-foreground">{importFileName}</span></p>
                <label className="cursor-pointer">
                  <Button variant="ghost" size="sm" asChild>
                    <span>Change file</span>
                  </Button>
                  <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportFile} />
                </label>
              </div>
              <div className="border rounded-md overflow-hidden">
                <div className="overflow-x-auto max-h-64">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50 sticky top-0">
                      <tr>
                        {["Name", "Title", "Email", "Phone", "Notes"].map(h => (
                          <th key={h} className="text-left px-3 py-2 font-medium text-muted-foreground">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {importRows.slice(0, 20).map((r, i) => (
                        <tr key={i} className="border-t border-muted/50">
                          <td className="px-3 py-2 font-medium">{r.name}</td>
                          <td className="px-3 py-2 text-muted-foreground">{r.title || "—"}</td>
                          <td className="px-3 py-2 text-muted-foreground">{r.email || "—"}</td>
                          <td className="px-3 py-2 text-muted-foreground">{r.phone || "—"}</td>
                          <td className="px-3 py-2 text-muted-foreground truncate max-w-[150px]">{r.notes || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {importRows.length > 20 && (
                  <div className="px-3 py-2 text-xs text-muted-foreground border-t bg-muted/30">+{importRows.length - 20} more rows not shown</div>
                )}
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>Cancel</Button>
          <Button onClick={() => bulkImportMutation.mutate(importRows)} disabled={importRows.length === 0 || bulkImportMutation.isPending} data-testid="button-confirm-import">
            {bulkImportMutation.isPending ? "Importing..." : `Import ${importRows.length > 0 ? importRows.length + " " : ""}Contact${importRows.length !== 1 ? "s" : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
