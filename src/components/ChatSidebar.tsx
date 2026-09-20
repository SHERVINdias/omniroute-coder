"use client";

/**
 * src/components/ChatSidebar.tsx
 * ---------------------------------------------------------------------------
 * ⚠️  THIS COMPONENT IS NOT RENDERED ANYWHERE.
 *
 * `grep -rn "ChatSidebar" src` finds no importer outside the backup files. The
 * sidebar you see in the app is written inline in `src/app/page.tsx` (look for
 * the `<aside>` just above "New chat"), and that is the one to edit.
 *
 * The banner is here because this file is a convincing decoy. It is a complete,
 * plausible sidebar with features the live one does not have — search, pinning,
 * rename, time grouping — so a search for "New Chat" or for a class name lands
 * here first and every change made to it has no effect on screen. That has
 * already cost time once.
 *
 * It also still carries the pre-token palette on purpose: `zinc-*`, `amber-*`,
 * `cyan-*` and `teal-*`, including an active row that is simultaneously teal,
 * cyan and shadowed. Leaving it un-migrated is the honest state of an orphan —
 * restyling it would make it look maintained without making it reachable.
 *
 * Two ways forward, whenever this next comes up: delete it, or adopt it in
 * page.tsx and delete the inline copy. Do not leave both.
 * ------------------------------------------------------------------------- */

import { useState, useMemo } from "react";
import {
  Plus,
  PanelLeft,
  Folder,
  Layers,
  MessageSquare,
  Trash2,
  Edit2,
  Pin,
  X,
  Search,
  Sparkle,
  Download,
  FolderArchive,
} from "lucide-react";
import { resolveDisplayName, resolveInitial } from "@/lib/displayName";

export interface ChatItem {
  id: string;
  title: string;
  updated_at: string;
}

interface ChatSidebarProps {
  isOpen: boolean;
  onToggle: () => void;
  chatList: ChatItem[];
  activeChatId: string;
  pinnedChats: Set<string>;
  onNewChat: () => void;
  onLoadChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
  onPinToggle: (id: string) => void;
  onRenameChat: (id: string, newTitle: string) => void;
  onOpenBackups?: () => void;
  /**
   * The signed-in account, for the footer row.
   *
   * Optional because nothing renders this component today — page.tsx has its
   * own inlined copy of the same sidebar. Leaving it required would make this
   * file a compile error the moment someone did wire it up, which is the worst
   * possible time to discover it.
   */
  user?: { email?: string | null; phone?: string | null; displayName?: string | null } | null;
}

type TimeGroup =
  | "pinned"
  | "today"
  | "yesterday"
  | "last7days"
  | "last30days"
  | "older";

export default function ChatSidebar({
  isOpen,
  onToggle,
  chatList,
  activeChatId,
  pinnedChats,
  onNewChat,
  onLoadChat,
  onDeleteChat,
  onPinToggle,
  onRenameChat,
  onOpenBackups,
  user,
}: ChatSidebarProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [hoveredChatId, setHoveredChatId] = useState<string | null>(null);

  const getTimeGroup = (dateString: string): TimeGroup => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return "today";
    if (diffDays === 1) return "yesterday";
    if (diffDays <= 7) return "last7days";
    if (diffDays <= 30) return "last30days";
    return "older";
  };

  const groupedChats = useMemo(() => {
    const filtered = chatList.filter((chat) =>
      chat.title.toLowerCase().includes(searchQuery.toLowerCase()),
    );

    const groups: Record<TimeGroup, ChatItem[]> = {
      pinned: [],
      today: [],
      yesterday: [],
      last7days: [],
      last30days: [],
      older: [],
    };

    filtered.forEach((chat) => {
      if (pinnedChats.has(chat.id)) {
        groups.pinned.push(chat);
      } else {
        const group = getTimeGroup(chat.updated_at);
        groups[group].push(chat);
      }
    });

    return groups;
  }, [chatList, searchQuery, pinnedChats]);

  const groupLabels: Record<TimeGroup, string> = {
    pinned: "PINNED",
    today: "Today",
    yesterday: "Yesterday",
    last7days: "Previous 7 Days",
    last30days: "Previous 30 Days",
    older: "Older",
  };

  const handleRenameStart = (chat: ChatItem) => {
    setRenamingChatId(chat.id);
    setRenameValue(chat.title);
  };

  const handleRenameSave = () => {
    if (renamingChatId && renameValue.trim()) {
      onRenameChat(renamingChatId, renameValue.trim());
    }
    setRenamingChatId(null);
    setRenameValue("");
  };

  const handleRenameCancel = () => {
    setRenamingChatId(null);
    setRenameValue("");
  };

  const renderChatItem = (chat: ChatItem) => {
    const isActive = chat.id === activeChatId;
    const isPinned = pinnedChats.has(chat.id);
    const isRenaming = renamingChatId === chat.id;
    const isHovered = hoveredChatId === chat.id;

    if (isRenaming) {
      return (
        <div
          key={chat.id}
          className="px-3 py-2 rounded-xl bg-zinc-800/80 border border-amber-500/40"
        >
          <input
            autoFocus
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRenameSave();
              if (e.key === "Escape") handleRenameCancel();
            }}
            className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-amber-500/60"
          />
          <div className="flex items-center gap-1.5 mt-1.5">
            <button
              type="button"
              onClick={handleRenameSave}
              className="flex-1 px-2 py-1 rounded-md bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-[10px] font-medium cursor-pointer transition-colors"
            >
              Save
            </button>
            <button
              type="button"
              onClick={handleRenameCancel}
              className="flex-1 px-2 py-1 rounded-md bg-zinc-700/50 hover:bg-zinc-700 text-zinc-300 text-[10px] font-medium cursor-pointer transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      );
    }

    return (
      <div
        key={chat.id}
        onMouseEnter={() => setHoveredChatId(chat.id)}
        onMouseLeave={() => setHoveredChatId(null)}
        onClick={() => onLoadChat(chat.id)}
        className={`group relative flex items-center justify-between px-3 py-2.5 rounded-xl cursor-pointer transition-all duration-200 ${
          isActive
            ? "bg-teal-500/10 border border-cyan-400/40 shadow-lg shadow-cyan-400/10 border-l-2 border-l-cyan-400"
            : "hover:bg-zinc-800/40 border border-transparent hover:border-zinc-700/40"
        }`}
      >
        {isActive && (
          <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-gradient-to-b from-cyan-400 to-cyan-500 rounded-r-full shadow-[0_0_10px_rgba(34,211,238,0.6)]" />
        )}

        <div className="flex items-center gap-2.5 truncate pr-2 min-w-0 flex-1 pl-2">
          <MessageSquare
            className={`w-3.5 h-3.5 shrink-0 transition-colors ${
              isActive
                ? "text-cyan-400"
                : "text-zinc-500 group-hover:text-zinc-400"
            }`}
          />
          <span
            className={`truncate text-xs font-medium transition-colors ${
              isActive
                ? "text-cyan-100"
                : "text-zinc-300 group-hover:text-zinc-100"
            }`}
          >
            {chat.title}
          </span>
          {isPinned && !isHovered && (
            <Pin className="w-3 h-3 text-amber-400/70 shrink-0 fill-amber-400/20" />
          )}
        </div>

        <div
          className={`flex items-center gap-1 shrink-0 transition-opacity duration-200 ${
            isHovered ? "opacity-100" : "opacity-0"
          }`}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPinToggle(chat.id);
            }}
            className={`p-1.5 rounded-lg transition-all hover:bg-zinc-700/80 ${
              isPinned ? "text-amber-400" : "text-zinc-500 hover:text-amber-400"
            }`}
            title={isPinned ? "Unpin chat" : "Pin chat"}
          >
            <Pin
              className={`w-3.5 h-3.5 ${isPinned ? "fill-amber-400" : ""}`}
            />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleRenameStart(chat);
            }}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-sky-400 hover:bg-zinc-700/80 transition-all"
            title="Rename chat"
          >
            <Edit2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDeleteChat(chat.id);
            }}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-rose-400 hover:bg-zinc-700/80 transition-all"
            title="Delete chat"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  };

  const renderGroup = (group: TimeGroup) => {
    const chats = groupedChats[group];
    if (chats.length === 0) return null;

    const isPinnedGroup = group === "pinned";

    return (
      <div key={group} className="space-y-1">
        <div
          className={`flex items-center gap-2 px-3 py-1.5 ${
            isPinnedGroup ? "pt-3" : "pt-2"
          }`}
        >
          {isPinnedGroup && (
            <Pin className="w-3 h-3 text-amber-400 fill-amber-400/30" />
          )}
          <span
            className={`text-[10px] font-bold uppercase tracking-wider ${
              isPinnedGroup ? "text-amber-400/90" : "text-zinc-500"
            }`}
          >
            {groupLabels[group]}
          </span>
          <div className="flex-1 h-px bg-gradient-to-r from-zinc-700/50 to-transparent" />
        </div>
        <div className="space-y-0.5">{chats.map(renderChatItem)}</div>
      </div>
    );
  };

  if (!isOpen) return null;

  return (
    <aside className="w-72 transition-all duration-300 bg-zinc-900/40 border-r border-zinc-800/50 flex flex-col justify-between shrink-0 z-20 backdrop-blur-xl shadow-2xl">
      <div className="p-4 space-y-4 flex-shrink-0">
        <div className="flex items-center justify-between px-2 pt-1">
          <span className="font-serif text-xl tracking-tight text-amber-100 font-semibold flex items-center gap-2">
            <Sparkle className="w-4 h-4 text-amber-400 fill-amber-400 drop-shadow-[0_0_8px_rgba(251,191,36,0.6)]" />
            Omni-Claude
          </span>
          <button
            onClick={onToggle}
            className="p-1.5 text-zinc-400 hover:text-zinc-200 rounded-lg hover:bg-zinc-800/80 cursor-pointer transition-colors"
          >
            <PanelLeft className="w-4 h-4" />
          </button>
        </div>

        <button
          onClick={onNewChat}
          className="w-full flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-gradient-to-r from-amber-500/10 to-amber-600/10 hover:from-amber-500/20 hover:to-amber-600/20 text-zinc-100 text-sm font-semibold border border-amber-500/30 hover:border-amber-500/50 transition-all cursor-pointer shadow-lg hover:shadow-amber-500/20 hover:scale-[1.02] active:scale-[0.98]"
        >
          <Plus className="w-4 h-4 text-amber-400" />
          <span>New Chat</span>
        </button>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search conversations..."
            className="w-full pl-9 pr-3 py-2 bg-zinc-800/40 border border-zinc-700/40 hover:border-zinc-600/50 focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/20 rounded-xl text-xs text-zinc-200 placeholder:text-zinc-500 focus:outline-none transition-all"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md hover:bg-zinc-700/60 text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        <div className="space-y-0.5 text-xs text-zinc-400">
          <div className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-zinc-800/40 hover:text-zinc-200 cursor-pointer transition-all duration-200">
            <Folder className="w-4 h-4 text-zinc-400" />
            <span>Projects</span>
          </div>
          <div className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-zinc-800/40 hover:text-zinc-200 cursor-pointer transition-all duration-200">
            <Layers className="w-4 h-4 text-zinc-400" />
            <span>Artifacts</span>
          </div>
          <div 
            onClick={onOpenBackups}
            className="flex items-center gap-2.5 px-3 py-2 rounded-xl hover:bg-zinc-800/40 hover:text-zinc-200 cursor-pointer transition-all duration-200"
          >
            <FolderArchive className="w-4 h-4 text-zinc-400" />
            <span>Backups</span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-2 [scrollbar-width:thin]">
        {chatList.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <MessageSquare className="w-8 h-8 text-zinc-700 mx-auto mb-2" />
            <p className="text-xs text-zinc-500 italic">No conversations yet</p>
            <p className="text-[10px] text-zinc-600 mt-1">
              Start a new chat to begin
            </p>
          </div>
        ) : (
          <>
            {renderGroup("pinned")}
            {renderGroup("today")}
            {renderGroup("yesterday")}
            {renderGroup("last7days")}
            {renderGroup("last30days")}
            {renderGroup("older")}

            {searchQuery &&
              Object.values(groupedChats).every((g) => g.length === 0) && (
                <div className="px-3 py-8 text-center">
                  <Search className="w-8 h-8 text-zinc-700 mx-auto mb-2" />
                  <p className="text-xs text-zinc-500">No chats found</p>
                  <p className="text-[10px] text-zinc-600 mt-1">
                    Try a different search term
                  </p>
                </div>
              )}
          </>
        )}
      </div>

      <div className="p-4 border-t border-zinc-800/80 flex items-center justify-between text-xs text-zinc-400 bg-zinc-950/60 flex-shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 shrink-0 rounded-full bg-gradient-to-br from-amber-500/20 to-amber-600/20 border border-amber-500/30 text-amber-300 flex items-center justify-center font-bold text-sm shadow-lg shadow-amber-500/10">
            {user ? resolveInitial(user) : "?"}
          </div>
          <span className="font-medium text-zinc-200 truncate">
            {user ? resolveDisplayName(user) : "Not signed in"}
          </span>
        </div>
        <Download className="w-4 h-4 cursor-pointer hover:text-zinc-200 transition-colors" />
      </div>
    </aside>
  );
}
