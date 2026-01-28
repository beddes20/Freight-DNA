import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Pencil,
  Trash2,
  Search,
  MapPin,
  Route,
  DollarSign,
  FileText,
  Mail,
  Phone,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Contact } from "@shared/schema";

interface ContactListProps {
  contacts: Contact[];
  companyId: string;
  onEditContact: (contact: Contact) => void;
}

export function ContactList({ contacts, companyId, onEditContact }: ContactListProps) {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);

  const deleteMutation = useMutation({
    mutationFn: async (contactId: string) => {
      await apiRequest("DELETE", `/api/contacts/${contactId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/companies", companyId, "contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
      toast({ title: "Contact deleted successfully" });
      setDeleteTarget(null);
    },
    onError: (error: Error) => {
      toast({ title: "Error deleting contact", description: error.message, variant: "destructive" });
    },
  });

  const filteredContacts = contacts.filter((contact) =>
    contact.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    contact.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    contact.regions?.some((r) => r.toLowerCase().includes(searchQuery.toLowerCase())) ||
    contact.lanes?.some((l) => l.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const contactsMap = new Map(contacts.map((c) => [c.id, c]));

  return (
    <div className="space-y-4">
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search contacts..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
          data-testid="input-search-contacts"
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {filteredContacts.map((contact) => {
          const initials = contact.name
            .split(" ")
            .map((n) => n[0])
            .join("")
            .slice(0, 2)
            .toUpperCase();

          const manager = contact.reportsToId ? contactsMap.get(contact.reportsToId) : null;

          return (
            <Card key={contact.id} data-testid={`card-contact-list-${contact.id}`}>
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <Avatar className="h-12 w-12 shrink-0">
                    <AvatarFallback className="bg-primary/10 text-primary font-medium">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h4 className="font-medium truncate">{contact.name}</h4>
                        {contact.title && (
                          <p className="text-sm text-muted-foreground truncate">
                            {contact.title}
                          </p>
                        )}
                        {manager && (
                          <p className="text-xs text-muted-foreground mt-1">
                            Reports to: {manager.name}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => onEditContact(contact)}
                          data-testid={`button-edit-contact-list-${contact.id}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setDeleteTarget(contact)}
                          data-testid={`button-delete-contact-${contact.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="mt-3 space-y-2">
                      {(contact.email || contact.phone) && (
                        <div className="flex flex-wrap gap-3 text-sm">
                          {contact.email && (
                            <a
                              href={`mailto:${contact.email}`}
                              className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
                            >
                              <Mail className="h-3.5 w-3.5" />
                              <span className="truncate">{contact.email}</span>
                            </a>
                          )}
                          {contact.phone && (
                            <a
                              href={`tel:${contact.phone}`}
                              className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
                            >
                              <Phone className="h-3.5 w-3.5" />
                              <span>{contact.phone}</span>
                            </a>
                          )}
                        </div>
                      )}

                      {contact.regions && contact.regions.length > 0 && (
                        <div className="flex items-start gap-2">
                          <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                          <div className="flex flex-wrap gap-1">
                            {contact.regions.map((region, i) => (
                              <Badge key={i} variant="secondary" className="text-xs">
                                {region}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}

                      {contact.lanes && contact.lanes.length > 0 && (
                        <div className="flex items-start gap-2">
                          <Route className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                          <div className="flex flex-wrap gap-1">
                            {contact.lanes.map((lane, i) => (
                              <Badge key={i} variant="outline" className="text-xs">
                                {lane}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}

                      {contact.freightSpend && (
                        <div className="flex items-center gap-2">
                          <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-sm font-medium">
                            ${Number(contact.freightSpend).toLocaleString()}
                          </span>
                          <span className="text-xs text-muted-foreground">annual freight spend</span>
                        </div>
                      )}

                      {contact.spotBiddingProcess && (
                        <div className="flex items-start gap-2">
                          <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                          <p className="text-xs text-muted-foreground line-clamp-2">
                            {contact.spotBiddingProcess}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {filteredContacts.length === 0 && (
        <div className="text-center py-8 text-muted-foreground">
          <p className="text-sm">No contacts match your search</p>
        </div>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Contact</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {deleteTarget?.name}? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-contact">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-contact"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
