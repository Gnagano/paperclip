import { useState } from "react";
import { createPortal } from "react-dom";
import { FileText, Pencil } from "lucide-react";
import { PROPERTIES_PANE_HEADER_SLOT_ID } from "./PropertiesPanel";
import { InlineEditor } from "./InlineEditor";
import { MarkdownBody, type MarkdownExternalReferenceMap } from "./MarkdownBody";
import type { MentionOption } from "./MarkdownEditor";
import { Button } from "@/components/ui/button";

interface IssueDescriptionPanelProps {
  description: string;
  onSave: (description: string) => void | Promise<unknown>;
  mentions?: MentionOption[];
  externalReferences?: MarkdownExternalReferenceMap;
}

export function IssueDescriptionPanel({
  description,
  onSave,
  mentions,
  externalReferences,
}: IssueDescriptionPanelProps) {
  const [editing, setEditing] = useState(false);
  const paneHeaderSlot = document.getElementById(PROPERTIES_PANE_HEADER_SLOT_ID);

  return (
    <>
      {paneHeaderSlot
        ? createPortal(<span className="text-sm font-medium">Description</span>, paneHeaderSlot)
        : null}
      <div className="flex flex-col gap-3" data-testid="issue-description-panel">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <FileText className="h-4 w-4 text-muted-foreground" aria-hidden />
            Task description
          </div>
          {!editing ? (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setEditing(true)}
              title="Edit description"
              aria-label="Edit description"
            >
              <Pencil className="h-4 w-4" />
            </Button>
          ) : null}
        </div>

        {editing ? (
          <InlineEditor
            value={description}
            onSave={onSave}
            as="p"
            className="text-sm leading-7 text-foreground"
            placeholder="Add a description..."
            multiline
            defaultEditing
            onEditingChange={setEditing}
            mentions={mentions}
            externalReferences={externalReferences}
          />
        ) : description.trim() ? (
          <MarkdownBody
            className="text-sm"
            softBreaks
            linkIssueReferences
            externalReferences={externalReferences}
          >
            {description}
          </MarkdownBody>
        ) : (
          <button
            type="button"
            className="rounded-md border border-dashed border-border px-3 py-4 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/20 hover:text-foreground"
            onClick={() => setEditing(true)}
          >
            Add a description...
          </button>
        )}
      </div>
    </>
  );
}
