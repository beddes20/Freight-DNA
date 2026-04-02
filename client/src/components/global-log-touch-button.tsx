import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { PhoneCall, Mail, MessageSquare, Building2, Search, Contact } from "lucide-react";

const TOUCH_TYPES = [
  { value: "call", label: "Call", icon: PhoneCall },
  { value: "email", label: "Email", icon: Mail },
  { value: "text", label: "Text", icon: MessageSquare },
  { value: "site_visit", label: "Site Visit", icon: Building2 },
];

const VIBES = [
  { value: "great", label: "Great", color: "bg-green-100 text-green-700 border-green-300 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700" },
  { value: "neutral", label: "Neutral", color: "bg-gray-100 text-gray-700 border-gray-300 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600" },
  { value: "cold", label: "Cold", color: "bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700" },
];

interface ContactResult {
  id: string;
  name: string;
  title?: string;
  companyId: string;
  companyName?: string;
}

export function GlobalLogTouchButton() {
  const [open, setOpen] = useState(false);
  const [contactSearch, setContactSearch] = useState("");
  const [selectedContact, setSelectedContact] = useState<ContactResult | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [touchType, setTouchType] = useState("call");
  const [meaningful, setMeaningful] = useState(false);
  const [vibe, setVibe] = useState("");
  const [notes, setNotes] = useState("");
  const { toast } = useToast();
  const dropdownRef = useRef<HTMLDivElement>(null);

  const { data: searchResults = [] } = useQuery<ContactResult[]>({
    queryKey: ["/api/search/contacts-for-touch", contactSearch],
    queryFn: async () => {
      if (!contactSearch.trim()) return [];
      const res = await fetch(`/api/search?q=${encodeURIComponent(contactSearch)}`, {
        credentials: "include",
      });
      if (!res.ok) return [];
      const data = await res.json();
      return data.contacts || [];
    },
    enabled: contactSearch.trim().length > 0,
  });

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const logTouchMutation = useMutation({
    mutationFn: async () => {
      if (!selectedContact) throw new Error("No contact selected");
      return apiRequest("POST", "/api/touch-logs", {
        companyId: selectedContact.companyId,
        contactId: selectedContact.id,
        type: touchType,
        isMeaningful: meaningful,
        sentiment: vibe || null,
        notes: notes.trim() || null,
      }).then(r => r.json());
    },
    onSuccess: () => {
      if (selectedContact) {
        queryClient.invalidateQueries({ queryKey: ["/api/companies", selectedContact.companyId, "touchpoints"] });
        queryClient.invalidateQueries({ queryKey: ["/api/companies", selectedContact.companyId, "touch-logs"] });
        queryClient.invalidateQueries({ queryKey: ["/api/touchpoints/company-summary"] });
      }
      toast({ title: "Touch logged successfully" });
      handleClose();
    },
    onError: () => {
      toast({ title: "Failed to log touch", variant: "destructive" });
    },
  });

  function handleClose() {
    setOpen(false);
    setContactSearch("");
    setSelectedContact(null);
    setShowDropdown(false);
    setTouchType("call");
    setMeaningful(false);
    setVibe("");
    setNotes("");
  }

  function handleSelectContact(contact: ContactResult) {
    setSelectedContact(contact);
    setContactSearch(contact.name);
    setShowDropdown(false);
  }

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="h-8 px-3 text-white/80 hover:text-white hover:bg-white/10 border border-white/20 text-xs font-medium whitespace-nowrap"
        onClick={() => setOpen(true)}
        data-testid="button-global-log-touch"
      >
        <PhoneCall className="h-3.5 w-3.5 mr-1.5" />
        Log Touch
      </Button>

      <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-global-log-touch">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PhoneCall className="h-4 w-4 text-cyan-500" />
              Log a Touch
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Contact</label>
              <div className="relative" ref={dropdownRef}>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <input
                    data-testid="input-touch-contact-search"
                    type="text"
                    className="w-full pl-9 pr-3 h-9 rounded-md border border-input bg-background text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    placeholder="Search for a contact..."
                    value={contactSearch}
                    onChange={(e) => {
                      setContactSearch(e.target.value);
                      setSelectedContact(null);
                      setShowDropdown(true);
                    }}
                    onFocus={() => { if (contactSearch.trim()) setShowDropdown(true); }}
                  />
                </div>
                {showDropdown && contactSearch.trim() && searchResults.length > 0 && (
                  <div
                    data-testid="dropdown-touch-contacts"
                    className="absolute top-full mt-1 w-full bg-popover border rounded-md shadow-lg z-50 max-h-48 overflow-auto"
                  >
                    {searchResults.map((contact) => (
                      <button
                        key={contact.id}
                        data-testid={`touch-contact-option-${contact.id}`}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent cursor-pointer text-left"
                        onClick={() => handleSelectContact(contact)}
                      >
                        <Contact className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <span className="truncate block font-medium">{contact.name}</span>
                          <span className="text-xs text-muted-foreground truncate block">
                            {[contact.companyName, contact.title].filter(Boolean).join(" · ")}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {selectedContact?.companyName && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1" data-testid="touch-selected-account">
                  <Building2 className="h-3 w-3" />
                  <span>{selectedContact.companyName}</span>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Touch Type</label>
              <div className="flex gap-2 flex-wrap">
                {TOUCH_TYPES.map((opt) => {
                  const Icon = opt.icon;
                  return (
                    <button
                      key={opt.value}
                      data-testid={`touch-type-${opt.value}`}
                      onClick={() => setTouchType(opt.value)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm border transition-colors ${
                        touchType === opt.value
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background border-input hover:bg-muted"
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                data-testid="toggle-meaningful-conversation"
                onClick={() => setMeaningful((v) => !v)}
                className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${meaningful ? "bg-primary" : "bg-muted"}`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${meaningful ? "translate-x-4" : "translate-x-0"}`}
                />
              </button>
              <label className="text-sm cursor-pointer select-none" onClick={() => setMeaningful((v) => !v)}>
                Meaningful conversation
              </label>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Call Vibe</label>
              <div className="flex gap-2">
                {VIBES.map((v) => (
                  <button
                    key={v.value}
                    data-testid={`vibe-${v.value}`}
                    onClick={() => setVibe(vibe === v.value ? "" : v.value)}
                    className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
                      vibe === v.value ? v.color : "bg-background border-input hover:bg-muted text-foreground"
                    }`}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Notes <span className="text-muted-foreground font-normal">(optional)</span></label>
              <Textarea
                data-testid="textarea-touch-notes"
                placeholder="What did you talk about?"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="resize-none"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={handleClose} data-testid="button-cancel-global-touch">
              Cancel
            </Button>
            <Button
              onClick={() => logTouchMutation.mutate()}
              disabled={!selectedContact || logTouchMutation.isPending}
              data-testid="button-submit-global-touch"
            >
              {logTouchMutation.isPending ? "Saving..." : "Log Touch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
