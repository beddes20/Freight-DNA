import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { X, CheckCircle } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

const interestOptions = [
  "Freight Tracking",
  "Dispatch Workflow",
  "Shipment Visibility",
  "Reporting",
  "Pricing",
  "Other",
];

const timeOptions = [
  "8:00 AM",
  "8:30 AM",
  "9:00 AM",
  "9:30 AM",
  "10:00 AM",
  "10:30 AM",
  "11:00 AM",
  "11:30 AM",
  "12:00 PM",
  "12:30 PM",
  "1:00 PM",
  "1:30 PM",
  "2:00 PM",
  "2:30 PM",
  "3:00 PM",
  "3:30 PM",
  "4:00 PM",
  "4:30 PM",
  "5:00 PM",
];

const formSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Enter a valid business email"),
  phone: z.string().optional(),
  interest: z.string().min(1, "Please select an area of interest"),
  preferredDate: z.string().min(1, "Preferred date is required"),
  preferredTime: z.string().min(1, "Preferred time is required"),
});

type FormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  onClose: () => void;
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "#111",
  border: "1px solid rgba(255,180,0,0.2)",
  borderRadius: "6px",
  color: "#fff",
  padding: "9px 12px",
  fontSize: "14px",
  outline: "none",
  transition: "border-color 0.15s",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "12px",
  fontWeight: 600,
  color: "rgba(255,180,0,0.8)",
  marginBottom: "5px",
  letterSpacing: "0.05em",
  textTransform: "uppercase",
};

const errorStyle: React.CSSProperties = {
  color: "#f87171",
  fontSize: "12px",
  marginTop: "4px",
};

export default function ScheduleDemoModal({ open, onClose }: Props) {
  const [submitted, setSubmitted] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      firstName: "",
      lastName: "",
      email: "",
      phone: "",
      interest: "",
      preferredDate: "",
      preferredTime: "",
    },
  });

  const mutation = useMutation({
    mutationFn: (data: FormValues) =>
      apiRequest("POST", "/api/demo-requests", data),
    onSuccess: () => {
      setSubmitted(true);
    },
  });

  const handleClose = () => {
    if (!mutation.isPending) {
      onClose();
      setTimeout(() => {
        setSubmitted(false);
        form.reset();
      }, 300);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
      onClick={e => { if (e.target === e.currentTarget) handleClose(); }}
      data-testid="modal-schedule-demo"
    >
      <div
        className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl"
        style={{ background: "#0f0f0f", border: "1px solid rgba(255,180,0,0.2)", boxShadow: "0 24px 64px rgba(0,0,0,0.6)" }}
        onClick={e => e.stopPropagation()}
      >
        <button
          onClick={handleClose}
          className="absolute top-4 right-4 flex items-center justify-center w-8 h-8 rounded-full transition-all duration-150"
          style={{ background: "rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.5)" }}
          data-testid="button-close-demo-modal"
          onMouseEnter={e => {
            (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.13)";
            (e.currentTarget as HTMLElement).style.color = "#fff";
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.07)";
            (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.5)";
          }}
        >
          <X className="w-4 h-4" />
        </button>

        <div className="p-8">
          {submitted ? (
            <div className="flex flex-col items-center text-center py-8 gap-4" data-testid="demo-success-message">
              <CheckCircle className="w-12 h-12" style={{ color: "#ffc333" }} />
              <h2 className="text-xl font-bold tracking-tight">You're on the list.</h2>
              <p className="text-sm leading-relaxed" style={{ color: "rgba(255,255,255,0.5)" }}>
                We'll be in touch shortly to confirm your demo.
              </p>
              <button
                onClick={handleClose}
                className="mt-4 text-sm font-semibold px-6 py-2 rounded transition-all duration-150"
                style={{ background: "#ffc333", color: "#0a0a0a" }}
                data-testid="button-close-success"
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#ffb400"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "#ffc333"; }}
              >
                Close
              </button>
            </div>
          ) : (
            <>
              <div className="mb-6">
                <p className="text-xs uppercase tracking-[0.2em] font-semibold mb-2" style={{ color: "rgba(255,180,0,0.65)" }}>
                  Freight DNA
                </p>
                <h2 className="text-2xl font-extrabold tracking-tight mb-1">Schedule a Demo</h2>
                <p className="text-sm" style={{ color: "rgba(255,255,255,0.4)" }}>
                  Tell us a bit about yourself and we'll reach out to confirm a time.
                </p>
              </div>

              <form
                onSubmit={form.handleSubmit(data => mutation.mutate(data))}
                className="flex flex-col gap-4"
                data-testid="form-schedule-demo"
              >
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label style={labelStyle}>First Name <span style={{ color: "#f87171" }}>*</span></label>
                    <input
                      {...form.register("firstName")}
                      placeholder="Jane"
                      style={inputStyle}
                      data-testid="input-first-name"
                    />
                    {form.formState.errors.firstName && (
                      <p style={errorStyle}>{form.formState.errors.firstName.message}</p>
                    )}
                  </div>
                  <div>
                    <label style={labelStyle}>Last Name <span style={{ color: "#f87171" }}>*</span></label>
                    <input
                      {...form.register("lastName")}
                      placeholder="Smith"
                      style={inputStyle}
                      data-testid="input-last-name"
                    />
                    {form.formState.errors.lastName && (
                      <p style={errorStyle}>{form.formState.errors.lastName.message}</p>
                    )}
                  </div>
                </div>

                <div>
                  <label style={labelStyle}>Business Email <span style={{ color: "#f87171" }}>*</span></label>
                  <input
                    {...form.register("email")}
                    type="email"
                    placeholder="jane@brokerage.com"
                    style={inputStyle}
                    data-testid="input-email"
                  />
                  {form.formState.errors.email && (
                    <p style={errorStyle}>{form.formState.errors.email.message}</p>
                  )}
                </div>

                <div>
                  <label style={labelStyle}>Phone Number <span style={{ color: "rgba(255,255,255,0.25)" }}>(optional)</span></label>
                  <input
                    {...form.register("phone")}
                    type="tel"
                    placeholder="+1 (555) 000-0000"
                    style={inputStyle}
                    data-testid="input-phone"
                  />
                </div>

                <div>
                  <label style={labelStyle}>What are you interested in? <span style={{ color: "#f87171" }}>*</span></label>
                  <select
                    {...form.register("interest")}
                    style={{ ...inputStyle, appearance: "none" }}
                    data-testid="select-interest"
                  >
                    <option value="">Select an area...</option>
                    {interestOptions.map(opt => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                  {form.formState.errors.interest && (
                    <p style={errorStyle}>{form.formState.errors.interest.message}</p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label style={labelStyle}>Preferred Date <span style={{ color: "#f87171" }}>*</span></label>
                    <input
                      {...form.register("preferredDate")}
                      type="date"
                      style={{ ...inputStyle, colorScheme: "dark" }}
                      data-testid="input-preferred-date"
                    />
                    {form.formState.errors.preferredDate && (
                      <p style={errorStyle}>{form.formState.errors.preferredDate.message}</p>
                    )}
                  </div>
                  <div>
                    <label style={labelStyle}>Time (CST) <span style={{ color: "#f87171" }}>*</span></label>
                    <select
                      {...form.register("preferredTime")}
                      style={{ ...inputStyle, appearance: "none" }}
                      data-testid="select-preferred-time"
                    >
                      <option value="">Select time...</option>
                      {timeOptions.map(t => (
                        <option key={t} value={t}>{t} CST</option>
                      ))}
                    </select>
                    {form.formState.errors.preferredTime && (
                      <p style={errorStyle}>{form.formState.errors.preferredTime.message}</p>
                    )}
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={mutation.isPending}
                  className="mt-2 text-sm font-bold py-3 rounded transition-all duration-150 disabled:opacity-60"
                  style={{ background: "#ffc333", color: "#0a0a0a" }}
                  data-testid="button-submit-demo"
                  onMouseEnter={e => {
                    if (!mutation.isPending) (e.currentTarget as HTMLElement).style.background = "#ffb400";
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLElement).style.background = "#ffc333";
                  }}
                >
                  {mutation.isPending ? "Submitting..." : "Request Demo"}
                </button>

                {mutation.isError && (
                  <p style={{ ...errorStyle, textAlign: "center" }} data-testid="error-demo-submit">
                    Something went wrong. Please try again.
                  </p>
                )}
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
