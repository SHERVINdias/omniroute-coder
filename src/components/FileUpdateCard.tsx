import React, { useState, useEffect } from "react";
import {
  FileText,
  Check,
  X,
  Shield,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

export interface DiffChange {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export function computeFileDiff(
  oldContent: string,
  newContent: string,
): DiffChange[] {
  const oldLines = oldContent ? oldContent.split("\n") : [];
  const newLines = newContent ? newContent.split("\n") : [];
  const changes: DiffChange[] = [];

  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (
      i < oldLines.length &&
      j < newLines.length &&
      oldLines[i] === newLines[j]
    ) {
      changes.push({ value: oldLines[i] });
      i++;
      j++;
    } else {
      if (i < oldLines.length) {
        changes.push({ value: oldLines[i], removed: true });
        i++;
      }
      if (j < newLines.length) {
        changes.push({ value: newLines[j], added: true });
        j++;
      }
    }
  }

  return changes;
}

interface FileUpdateCardProps {
  fileName: string;
  filePath: string;
  oldContent?: string;
  newContent: string;
  onApprove?: (filePath: string, content: string) => void;
  onReject?: (filePath: string) => void;
}

export const FileUpdateCard: React.FC<FileUpdateCardProps> = ({
  fileName,
  filePath,
  oldContent = "",
  newContent,
  onApprove,
  onReject,
}) => {
  const [isTrustMode, setIsTrustMode] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("omniroute_trust_mode") === "true";
  });
  const [isExpanded, setIsExpanded] = useState(false);
  const [status, setStatus] = useState<"pending" | "approved" | "rejected">(
    "pending",
  );

  const diffs: DiffChange[] = computeFileDiff(oldContent, newContent);

  const toggleTrustMode = () => {
    const nextVal = !isTrustMode;
    setIsTrustMode(nextVal);
    if (typeof window !== "undefined") {
      localStorage.setItem("omniroute_trust_mode", String(nextVal));
    }
  };

  const handleApprove = () => {
    setStatus("approved");
    if (onApprove) onApprove(filePath, newContent);
  };

  const handleReject = () => {
    setStatus("rejected");
    if (onReject) onReject(filePath);
  };

  useEffect(() => {
    if (isTrustMode && status === "pending") {
      handleApprove();
    }
  }, [isTrustMode]);

  return (
    <div className="my-3 rounded-lg border border-neutral-800 bg-neutral-900/90 overflow-hidden text-sm shadow-md">
      <div className="flex items-center justify-between p-3 bg-neutral-900">
        <div className="flex items-center gap-3 overflow-hidden">
          <FileText className="w-4 h-4 text-amber-500 shrink-0" />
          <div className="truncate">
            <p className="font-medium text-neutral-200 truncate">{fileName}</p>
            <p className="text-xs text-neutral-500 truncate">{filePath}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleTrustMode}
            title="Toggle Trust Mode (Auto-approve edits)"
            className={`flex items-center gap-1 text-xs px-2 py-1 rounded border cursor-pointer transition-colors ${
              isTrustMode
                ? "border-emerald-500/50 bg-emerald-950/30 text-emerald-400"
                : "border-neutral-700 bg-neutral-800 text-neutral-400"
            }`}
          >
            {isTrustMode ? (
              <ShieldCheck className="w-3.5 h-3.5" />
            ) : (
              <Shield className="w-3.5 h-3.5" />
            )}
            Trust Mode
          </button>

          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1 hover:bg-neutral-800 rounded text-neutral-400 cursor-pointer"
          >
            {isExpanded ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="p-3 bg-black/40 border-t border-neutral-800 font-mono text-xs max-h-60 overflow-y-auto">
          {diffs.map((part, idx) => (
            <div
              key={idx}
              className={`${
                part.added
                  ? "bg-emerald-950/40 text-emerald-300"
                  : part.removed
                    ? "bg-rose-950/40 text-rose-400 line-through"
                    : "text-neutral-400"
              } whitespace-pre-wrap px-2 py-0.5`}
            >
              {part.added ? "+ " : part.removed ? "- " : "  "}
              {part.value}
            </div>
          ))}
        </div>
      )}

      {status === "pending" && !isTrustMode && (
        <div className="flex justify-end gap-2 p-2 bg-neutral-900/50 border-t border-neutral-800">
          <button
            type="button"
            onClick={handleReject}
            className="flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-rose-950/50 text-rose-300 hover:bg-rose-900/50 border border-rose-800/40 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" /> Reject
          </button>
          <button
            type="button"
            onClick={handleApprove}
            className="flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-emerald-950/50 text-emerald-300 hover:bg-emerald-900/50 border border-emerald-800/40 cursor-pointer"
          >
            <Check className="w-3.5 h-3.5" /> Approve
          </button>
        </div>
      )}

      {status !== "pending" && (
        <div className="px-3 py-1.5 bg-neutral-950/60 border-t border-neutral-800/80 text-[11px] font-medium flex items-center gap-1.5">
          {status === "approved" ? (
            <span className="text-emerald-400 flex items-center gap-1">
              <Check className="w-3 h-3" /> Edit Applied
            </span>
          ) : (
            <span className="text-rose-400 flex items-center gap-1">
              <X className="w-3 h-3" /> Edit Rejected
            </span>
          )}
        </div>
      )}
    </div>
  );
};

export default FileUpdateCard;
