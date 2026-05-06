import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Bold, Italic, Underline as UnderlineIcon, Link as LinkIcon,
  Image as ImageIcon, AlignLeft, AlignCenter, AlignRight,
  Palette, Trash2, Code,
} from "lucide-react";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";

interface SignatureEditorProps {
  value: string;
  onChange: (html: string) => void;
}

const COLORS = [
  "#000000", "#374151", "#6b7280", "#ef4444", "#f97316",
  "#eab308", "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899",
  "#ffffff",
];

export function SignatureEditor({ value, onChange }: SignatureEditorProps) {
  const [linkUrl, setLinkUrl] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const [sourceMode, setSourceMode] = useState(false);
  const [sourceHtml, setSourceHtml] = useState(value || "");

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, blockquote: false, code: false, codeBlock: false, horizontalRule: false }),
      Underline,
      TextStyle,
      Color,
      TextAlign.configure({ types: ["paragraph"] }),
      Link.configure({ openOnClick: false, HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } }),
      Image.configure({ HTMLAttributes: { style: "max-width: 300px; height: auto;" } }),
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
    ],
    content: value || "",
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    editorProps: {
      attributes: {
        class: "sig-prosemirror px-3 py-2 focus:outline-none",
      },
    },
  });

  if (!editor) return null;

  function toggleSourceMode() {
    if (!sourceMode) {
      // entering source mode — snapshot current HTML into textarea
      setSourceHtml(editor.getHTML());
    } else {
      // leaving source mode — push raw HTML back into editor
      editor.commands.setContent(sourceHtml, { emitUpdate: false });
      onChange(sourceHtml);
    }
    setSourceMode(s => !s);
  }

  function insertLink() {
    if (!linkUrl) return;
    const href = linkUrl.startsWith("http") ? linkUrl : `https://${linkUrl}`;
    if (editor.state.selection.empty) {
      editor.chain().focus().insertContent(`<a href="${href}">${href}</a>`).run();
    } else {
      editor.chain().focus().setLink({ href }).run();
    }
    setLinkUrl("");
    setLinkOpen(false);
  }

  function insertImage() {
    if (!imageUrl) return;
    const src = imageUrl.startsWith("http") ? imageUrl : `https://${imageUrl}`;
    editor.chain().focus().setImage({ src }).run();
    setImageUrl("");
    setImageOpen(false);
  }

  const ToolbarBtn = ({
    active, onClick, title, children,
  }: { active?: boolean; onClick: () => void; title: string; children: React.ReactNode }) => (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`h-7 w-7 flex items-center justify-center rounded text-sm transition-colors
        ${active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
    >
      {children}
    </button>
  );

  return (
    <div className="rounded-md border border-input bg-background overflow-hidden">
      <div className="flex items-center gap-0.5 p-1.5 border-b border-input bg-muted/40 flex-wrap">
        <ToolbarBtn active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold">
          <Bold className="h-3.5 w-3.5" />
        </ToolbarBtn>
        <ToolbarBtn active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic">
          <Italic className="h-3.5 w-3.5" />
        </ToolbarBtn>
        <ToolbarBtn active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()} title="Underline">
          <UnderlineIcon className="h-3.5 w-3.5" />
        </ToolbarBtn>

        <div className="w-px h-5 bg-border mx-0.5" />

        <ToolbarBtn active={editor.isActive({ textAlign: "left" })} onClick={() => editor.chain().focus().setTextAlign("left").run()} title="Align left">
          <AlignLeft className="h-3.5 w-3.5" />
        </ToolbarBtn>
        <ToolbarBtn active={editor.isActive({ textAlign: "center" })} onClick={() => editor.chain().focus().setTextAlign("center").run()} title="Align center">
          <AlignCenter className="h-3.5 w-3.5" />
        </ToolbarBtn>
        <ToolbarBtn active={editor.isActive({ textAlign: "right" })} onClick={() => editor.chain().focus().setTextAlign("right").run()} title="Align right">
          <AlignRight className="h-3.5 w-3.5" />
        </ToolbarBtn>

        <div className="w-px h-5 bg-border mx-0.5" />

        <Popover open={linkOpen} onOpenChange={setLinkOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              title="Insert link"
              className={`h-7 w-7 flex items-center justify-center rounded text-sm transition-colors
                ${editor.isActive("link") ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
            >
              <LinkIcon className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-3 space-y-2" align="start">
            <p className="text-xs font-medium">Insert link</p>
            <div className="flex gap-2">
              <Input
                value={linkUrl}
                onChange={e => setLinkUrl(e.target.value)}
                onKeyDown={e => e.key === "Enter" && insertLink()}
                placeholder="https://..."
                className="h-8 text-xs"
                autoFocus
              />
              <Button size="sm" onClick={insertLink} className="h-8 px-3 text-xs">Add</Button>
            </div>
            {editor.isActive("link") && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { editor.chain().focus().unsetLink().run(); setLinkOpen(false); }}
                className="h-7 text-xs text-destructive"
              >
                Remove link
              </Button>
            )}
          </PopoverContent>
        </Popover>

        <Popover open={imageOpen} onOpenChange={setImageOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              title="Insert logo / image"
              className="h-7 w-7 flex items-center justify-center rounded text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <ImageIcon className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-3 space-y-2" align="start">
            <p className="text-xs font-medium">Insert logo / image</p>
            <p className="text-[11px] text-muted-foreground">Paste a public image URL (e.g. from your company website or an image hosting service)</p>
            <div className="flex gap-2">
              <Input
                value={imageUrl}
                onChange={e => setImageUrl(e.target.value)}
                onKeyDown={e => e.key === "Enter" && insertImage()}
                placeholder="https://example.com/logo.png"
                className="h-8 text-xs"
                autoFocus
              />
              <Button size="sm" onClick={insertImage} className="h-8 px-3 text-xs">Insert</Button>
            </div>
          </PopoverContent>
        </Popover>

        <div className="w-px h-5 bg-border mx-0.5" />

        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              title="Text color"
              className="h-7 w-7 flex items-center justify-center rounded text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <Palette className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-2" align="start">
            <p className="text-[11px] text-muted-foreground mb-2">Text color</p>
            <div className="flex flex-wrap gap-1 max-w-[140px]">
              {COLORS.map(color => (
                <button
                  key={color}
                  type="button"
                  className="h-5 w-5 rounded border border-border hover:scale-110 transition-transform"
                  style={{ backgroundColor: color }}
                  onClick={() => editor.chain().focus().setColor(color).run()}
                  title={color}
                />
              ))}
              <button
                type="button"
                className="h-5 w-5 rounded border border-border flex items-center justify-center hover:bg-muted"
                onClick={() => editor.chain().focus().unsetColor().run()}
                title="Remove color"
              >
                <Trash2 className="h-3 w-3 text-muted-foreground" />
              </button>
            </div>
          </PopoverContent>
        </Popover>

        <div className="flex-1" />

        <button
          type="button"
          onClick={toggleSourceMode}
          className={`text-[10px] transition-colors px-1.5 py-0.5 rounded ${sourceMode ? "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 font-medium" : "text-muted-foreground hover:text-foreground"}`}
          title={sourceMode ? "Back to visual editor" : "Edit raw HTML source"}
        >
          {sourceMode ? "Visual" : "Source"}
        </button>

        <button
          type="button"
          onClick={() => { editor.commands.clearContent(); setSourceHtml(""); onChange(""); }}
          className="text-[10px] text-muted-foreground hover:text-destructive transition-colors px-1"
          title="Clear signature"
        >
          Clear
        </button>
      </div>

      {sourceMode ? (
        <Textarea
          value={sourceHtml}
          onChange={e => { setSourceHtml(e.target.value); onChange(e.target.value); }}
          className="font-mono text-[11px] min-h-[140px] max-h-[180px] overflow-y-auto resize-none rounded-none border-0 border-t border-border focus-visible:ring-0 bg-muted/30"
          placeholder="<table>...</table>"
          spellCheck={false}
        />
      ) : (
        <div className="sig-editor-scroll overflow-y-auto max-h-[180px] bg-background">
          <EditorContent editor={editor} />
        </div>
      )}
    </div>
  );
}
