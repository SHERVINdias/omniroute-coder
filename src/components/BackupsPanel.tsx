"use client";

import { useState, useEffect } from "react";
import { X, FolderArchive, FileText, Clock, RotateCcw, Loader2 } from "lucide-react";

interface BackupFile {
  path: string;
  timestamp: string;
  size: number;
  originalPath: string;
}

interface BackupsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  workspacePath: string;
}

export default function BackupsPanel({ isOpen, onClose, workspacePath }: BackupsPanelProps) {
  const [backups, setBackups] = useState<BackupFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && workspacePath) {
      loadBackups();
    }
  }, [isOpen, workspacePath]);

  const loadBackups = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/backups?workspace=${encodeURIComponent(workspacePath)}`);
      if (!response.ok) {
        throw new Error("Failed to load backups");
      }
      const data = await response.json();
      setBackups(data.backups || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load backups");
    } finally {
      setLoading(false);
    }
  };

  const handleRestore = async (backup: BackupFile) => {
    if (!confirm(`Restore ${backup.originalPath} to the version from ${formatTimestamp(backup.timestamp)}?\n\nYour current file will be backed up automatically, so you can restore it again if needed.`)) {
      return;
    }

    setRestoring(backup.path);
    setError(null);
    try {
      const response = await fetch("/api/backups/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          backupPath: backup.path,
          originalPath: backup.originalPath,
          workspace: workspacePath,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to restore backup");
      }

      const result = await response.json();
      
      // Show success message with backup info
      if (result.createdBackup) {
        alert("✓ File restored successfully!\n\nYour previous version has been backed up. You can restore it by clicking the newest backup entry.");
      } else {
        alert("✓ File restored successfully!");
      }
      
      // Reload backups to show the new backup created during restore
      await loadBackups();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to restore backup";
      setError(errorMsg);
      alert("✗ " + errorMsg);
    } finally {
      setRestoring(null);
    }
  };

  const formatTimestamp = (timestamp: string) => {
    try {
      const date = new Date(timestamp);
      if (isNaN(date.getTime())) {
        return "Invalid Date";
      }
      return date.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch {
      return "Invalid Date";
    }
  };

  const getRelativeTime = (timestamp: string) => {
    try {
      const date = new Date(timestamp);
      if (isNaN(date.getTime())) {
        return "";
      }
      const now = new Date();
      const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
      
      if (seconds < 60) return "just now";
      if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
      if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
      if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
      return date.toLocaleDateString();
    } catch {
      return "";
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const groupBackupsByFile = () => {
    const grouped: Record<string, BackupFile[]> = {};
    backups.forEach((backup) => {
      if (!grouped[backup.originalPath]) {
        grouped[backup.originalPath] = [];
      }
      grouped[backup.originalPath].push(backup);
    });

    // Sort by timestamp descending (latest first) and limit to 10 per file
    Object.keys(grouped).forEach((path) => {
      grouped[path] = grouped[path]
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, 10);
    });

    return grouped;
  };

  if (!isOpen) return null;

  const groupedBackups = groupBackupsByFile();

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 transition-opacity"
        onClick={onClose}
      />

      {/* Slide-out Panel */}
      <div className="fixed right-0 top-0 h-full w-[650px] bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-950 border-l border-zinc-700/50 shadow-2xl z-50 flex flex-col animate-slide-in">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-zinc-800/80 bg-zinc-800/30 backdrop-blur-sm">
          <div className="flex items-center gap-4">
            <div className="p-3 rounded-xl bg-gradient-to-br from-amber-500/20 to-amber-600/10 border-2 border-amber-500/30 shadow-lg shadow-amber-500/10">
              <FolderArchive className="w-6 h-6 text-amber-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-zinc-100 tracking-tight">File Backups</h2>
              <p className="text-xs text-zinc-400 mt-1 font-medium">
                {workspacePath ? (
                  <>
                    <span className="text-amber-400">●</span> {workspacePath.split(/[/\\]/).pop()}
                  </>
                ) : (
                  "No workspace selected"
                )}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2.5 rounded-xl hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-all hover:scale-105 active:scale-95"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-20">
              <div className="relative">
                <div className="absolute inset-0 rounded-full bg-amber-500/20 blur-xl"></div>
                <Loader2 className="w-12 h-12 text-amber-400 animate-spin relative" />
              </div>
              <p className="text-zinc-400 text-sm mt-6 font-medium">Loading backups...</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-20">
              <div className="p-4 rounded-2xl bg-red-500/10 border-2 border-red-500/30 mb-4">
                <X className="w-8 h-8 text-red-400" />
              </div>
              <p className="text-red-400 text-sm font-semibold mb-2">Failed to load backups</p>
              <p className="text-zinc-500 text-xs mb-6">{error}</p>
              <button
                onClick={loadBackups}
                className="px-5 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-xl text-sm font-semibold transition-all hover:scale-105 active:scale-95 shadow-lg"
              >
                Try Again
              </button>
            </div>
          ) : Object.keys(groupedBackups).length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20">
              <div className="relative mb-6">
                <div className="absolute inset-0 rounded-full bg-zinc-700/20 blur-2xl"></div>
                <div className="relative p-6 rounded-2xl bg-zinc-800/50 border-2 border-zinc-700/50">
                  <FolderArchive className="w-16 h-16 text-zinc-600" />
                </div>
              </div>
              <h3 className="text-zinc-300 text-base font-bold mb-2">No backups yet</h3>
              <p className="text-zinc-500 text-sm text-center max-w-sm leading-relaxed">
                Your file backups will appear here automatically when you make changes. 
                Every restore creates a backup of your current version.
              </p>
              <div className="mt-8 p-4 rounded-xl bg-amber-500/5 border border-amber-500/20 max-w-md">
                <p className="text-xs text-amber-400/80 text-center">
                  💡 Tip: You can toggle between versions by restoring multiple times
                </p>
              </div>
            </div>
          ) : (
            Object.entries(groupedBackups).map(([filePath, fileBackups]) => (
              <div key={filePath} className="space-y-3">
                {/* File Header */}
                <div className="flex items-center gap-2 px-1">
                  <div className="p-1.5 rounded-md bg-blue-500/10 border border-blue-500/20">
                    <FileText className="w-3.5 h-3.5 text-blue-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold text-zinc-200 truncate">{filePath}</h3>
                    <p className="text-[10px] text-zinc-500 mt-0.5">{fileBackups.length} backup{fileBackups.length !== 1 ? 's' : ''} available</p>
                  </div>
                </div>
                
                {/* Backup Cards */}
                <div className="space-y-2">
                  {fileBackups.map((backup, index) => {
                    const isLatest = index === 0;
                    const relativeTime = getRelativeTime(backup.timestamp);
                    
                    return (
                      <div
                        key={backup.path}
                        className={`group relative flex items-center justify-between p-4 rounded-xl transition-all duration-200 ${
                          isLatest
                            ? 'bg-gradient-to-br from-amber-500/10 to-amber-600/5 border-2 border-amber-500/30 shadow-lg shadow-amber-500/5'
                            : 'bg-zinc-800/40 border border-zinc-700/50 hover:border-zinc-600/50 hover:bg-zinc-800/60'
                        }`}
                      >
                        {/* Latest Badge */}
                        {isLatest && (
                          <div className="absolute -top-2 -right-2 px-2 py-0.5 bg-amber-500 text-zinc-900 text-[10px] font-bold rounded-full shadow-lg">
                            LATEST
                          </div>
                        )}
                        
                        <div className="flex items-start gap-3 flex-1 min-w-0">
                          {/* Icon */}
                          <div className={`p-2 rounded-lg shrink-0 ${
                            isLatest 
                              ? 'bg-amber-500/20 border border-amber-500/30' 
                              : 'bg-zinc-700/50 border border-zinc-600/30 group-hover:bg-zinc-700 group-hover:border-zinc-600'
                          }`}>
                            <Clock className={`w-4 h-4 ${isLatest ? 'text-amber-400' : 'text-zinc-400 group-hover:text-zinc-300'}`} />
                          </div>
                          
                          {/* Content */}
                          <div className="flex-1 min-w-0 space-y-1">
                            <div className="flex items-baseline gap-2">
                              <p className={`text-sm font-semibold ${isLatest ? 'text-amber-300' : 'text-zinc-200'}`}>
                                {formatTimestamp(backup.timestamp)}
                              </p>
                              {relativeTime && (
                                <span className="text-[10px] text-zinc-500 font-medium">
                                  {relativeTime}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="text-xs text-zinc-400 font-mono">
                                {formatFileSize(backup.size)}
                              </span>
                              {isLatest && (
                                <span className="text-[10px] text-amber-400/70 font-medium">
                                  • Most recent version
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        
                        {/* Restore Button */}
                        <button
                          onClick={() => handleRestore(backup)}
                          disabled={restoring === backup.path}
                          className={`flex items-center gap-2 px-4 py-2 rounded-lg font-semibold text-sm transition-all duration-200 shrink-0 shadow-md ${
                            isLatest
                              ? 'bg-amber-500 hover:bg-amber-400 text-zinc-900 shadow-amber-500/20 hover:shadow-amber-500/30 hover:scale-105'
                              : 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200 hover:text-white shadow-zinc-900/30 hover:shadow-zinc-900/50'
                          } disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100`}
                        >
                          {restoring === backup.path ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />
                              <span>Restoring...</span>
                            </>
                          ) : (
                            <>
                              <RotateCcw className="w-4 h-4" />
                              <span>Restore</span>
                            </>
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
