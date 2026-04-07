import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Pencil, Trash2, Mail, Phone, Link as LinkIcon } from "lucide-react";
import { PROSPECT_CONTACT_ROLES } from "@shared/schema";
import type { ProspectContact } from "@shared/schema";
import { CONTACT_ROLE_LABELS, CONTACT_ROLE_COLORS } from "../types";

export function ContactsTab({ prospectId }: { prospectId: number }) {
  const { toast } = useToast();
  const [addingContact, setAddingContact] = useState(false);
  const [editingContact, setEditingContact] = useState<ProspectContact | null>(null);
  const [contactForm, setContactForm] = useState({ name: "", title: "", email: "", phone: "", linkedin: "", role: "other", notes: "" });

  const { data: contacts = [], isLoading } = useQuery<ProspectContact[]>({
    queryKey: ["/api/prospects", prospectId, "contacts"],
    queryFn: async () => {
      const res = await fetch(`/api/prospects/${prospectId}/contacts`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const resetForm = () => setContactForm({ name: "", title: "", email: "", phone: "", linkedin: "", role: "other", notes: "" });

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/prospects/${prospectId}/contacts`, contactForm);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospects", prospectId, "contacts"] });
      toast({ title: "Contact added" });
      setAddingContact(false);
      resetForm();
    },
    onError: () => toast({ title: "Failed to add contact", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/prospects/${prospectId}/contacts/${editingContact!.id}`, contactForm);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospects", prospectId, "contacts"] });
      toast({ title: "Contact updated" });
      setEditingContact(null);
      resetForm();
    },
    onError: () => toast({ title: "Failed to update contact", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/prospects/${prospectId}/contacts/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prospects", prospectId, "contacts"] });
      toast({ title: "Contact removed" });
    },
    onError: () => toast({ title: "Failed to remove contact", variant: "destructive" }),
  });

  const startEdit = (c: ProspectContact) => {
    setEditingContact(c);
    setContactForm({ name: c.name, title: c.title ?? "", email: c.email ?? "", phone: c.phone ?? "", linkedin: c.linkedin ?? "", role: c.role ?? "other", notes: c.notes ?? "" });
    setAddingContact(false);
  };

  const setField = (k: string, v: string) => setContactForm(prev => ({ ...prev, [k]: v }));

  const ContactForm = ({ onSave, onCancel, isPending }: { onSave: () => void; onCancel: () => void; isPending: boolean }) => (
    <div className="border rounded-lg p-3 space-y-2.5 bg-muted/20">
      <div className="grid grid-cols-2 gap-2">
        <div className="col-span-2">
          <Label className="text-xs">Name *</Label>
          <Input value={contactForm.name} onChange={e => setField("name", e.target.value)} placeholder="Jane Smith" className="mt-1 h-8 text-sm" data-testid="input-contact-name" />
        </div>
        <div>
          <Label className="text-xs">Title</Label>
          <Input value={contactForm.title} onChange={e => setField("title", e.target.value)} placeholder="VP of Logistics" className="mt-1 h-8 text-sm" data-testid="input-contact-title" />
        </div>
        <div>
          <Label className="text-xs">Role</Label>
          <Select value={contactForm.role} onValueChange={v => setField("role", v)}>
            <SelectTrigger className="mt-1 h-8 text-xs" data-testid="select-contact-role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROSPECT_CONTACT_ROLES.map(r => (
                <SelectItem key={r} value={r} className="text-xs">{CONTACT_ROLE_LABELS[r]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Email</Label>
          <Input value={contactForm.email} onChange={e => setField("email", e.target.value)} placeholder="jane@company.com" className="mt-1 h-8 text-sm" data-testid="input-contact-email" />
        </div>
        <div>
          <Label className="text-xs">Phone</Label>
          <Input value={contactForm.phone} onChange={e => setField("phone", e.target.value)} placeholder="555-555-5555" className="mt-1 h-8 text-sm" data-testid="input-contact-phone" />
        </div>
        <div className="col-span-2">
          <Label className="text-xs">LinkedIn URL</Label>
          <Input value={contactForm.linkedin} onChange={e => setField("linkedin", e.target.value)} placeholder="https://linkedin.com/in/…" className="mt-1 h-8 text-sm" data-testid="input-contact-linkedin" />
        </div>
        <div className="col-span-2">
          <Label className="text-xs">Notes</Label>
          <Textarea value={contactForm.notes} onChange={e => setField("notes", e.target.value)} placeholder="Context about this person…" className="mt-1 text-sm min-h-[50px]" data-testid="input-contact-notes" />
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onCancel}>Cancel</Button>
        <Button size="sm" className="h-7 text-xs" onClick={onSave} disabled={!contactForm.name.trim() || isPending}>
          Save
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      {isLoading ? (
        <div className="space-y-2">{[1,2].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : contacts.length === 0 && !addingContact ? (
        <p className="text-sm text-muted-foreground text-center py-4">No stakeholders added yet.</p>
      ) : (
        <div className="space-y-2">
          {contacts.map(c => (
            editingContact?.id === c.id ? (
              <ContactForm key={c.id} onSave={() => updateMutation.mutate()} onCancel={() => { setEditingContact(null); resetForm(); }} isPending={updateMutation.isPending} />
            ) : (
              <div key={c.id} className="border rounded-lg p-3 space-y-1.5" data-testid={`contact-card-${c.id}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{c.name}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${CONTACT_ROLE_COLORS[c.role ?? "other"]}`}>
                        {CONTACT_ROLE_LABELS[c.role ?? "other"]}
                      </span>
                    </div>
                    {c.title && <p className="text-xs text-muted-foreground mt-0.5">{c.title}</p>}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => startEdit(c)} data-testid={`button-edit-contact-${c.id}`}><Pencil className="h-3 w-3" /></Button>
                    <Button size="icon" variant="ghost" className="h-6 w-6 text-red-500 hover:text-red-600" onClick={() => { if (confirm(`Remove ${c.name}?`)) deleteMutation.mutate(c.id); }} data-testid={`button-delete-contact-${c.id}`}><Trash2 className="h-3 w-3" /></Button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                  {c.email && <a href={`mailto:${c.email}`} className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"><Mail className="h-2.5 w-2.5" />{c.email}</a>}
                  {c.phone && <a href={`tel:${c.phone}`} className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"><Phone className="h-2.5 w-2.5" />{c.phone}</a>}
                  {c.linkedin && <a href={c.linkedin} target="_blank" rel="noreferrer" className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"><LinkIcon className="h-2.5 w-2.5" />LinkedIn</a>}
                </div>
                {c.notes && <p className="text-xs text-muted-foreground">{c.notes}</p>}
              </div>
            )
          ))}
        </div>
      )}

      {addingContact ? (
        <ContactForm onSave={() => createMutation.mutate()} onCancel={() => { setAddingContact(false); resetForm(); }} isPending={createMutation.isPending} />
      ) : (
        <Button size="sm" variant="outline" className="w-full gap-1.5 h-8 text-xs" onClick={() => { setAddingContact(true); setEditingContact(null); }} data-testid="button-add-contact">
          <Plus className="h-3.5 w-3.5" /> Add Stakeholder
        </Button>
      )}
    </div>
  );
}
