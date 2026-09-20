'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Play, 
  Square, 
  Rocket,
  Loader2,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Upload,
  FileJson,
  CheckCircle2,
  Clock,
  AlertCircle,
  Activity,
} from 'lucide-react';

interface ProductionAgentModeProps {
  isEnabled: boolean;
  onToggle: (enabled: boolean) => void;
  currentProvider: any;
  projectRoot: string;
  selectedModel: string;
  authToken?: string;
  selectedProviderId?: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  stage?: string;
  stageLabel?: string;
  toolCalls?: string[];
  timestamp: number;
  streaming?: boolean;
  error?: string;
  phaseId?: string;
  task?: string;
}

interface PhaseDefinition {
  id: string;
  name: string;
  description: string;
  tasks: string[];
  dependencies?: string[];
  verificationCriteria?: string[];
}

interface PhasePlan {
  phases: PhaseDefinition[];
}

interface PhaseStatus {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'awaiting_approval' | 'error';
  progress: number;
}

export default function ProductionAgentMode({
  isEnabled,
  onToggle,
  currentProvider,
  projectRoot,
  selectedModel,
  authToken,
  selectedProviderId,
}: ProductionAgentModeProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [phasePlan, setPhasePlan] = useState<PhasePlan | null>(null);
  const [phaseStatuses, setPhaseStatuses] = useState<PhaseStatus[]>([]);
  const [currentPhaseId, setCurrentPhaseId] = useState<string | null>(null);
  const [awaitingApproval, setAwaitingApproval] = useState<{
    phaseId: string;
    phaseName: string;
    nextPhase?: string;
  } | null>(null);
  
  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Load phase plan from file
  const handlePlanUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      let plan: PhasePlan;

      if (file.name.endsWith('.json')) {
        plan = JSON.parse(text);
      } else if (file.name.endsWith('.yaml') || file.name.endsWith('.yml')) {
        // Simple YAML parser for phase plans
        const lines = text.split('\n');
        const phases: PhaseDefinition[] = [];
        let currentPhase: Partial<PhaseDefinition> | null = null;
        let currentArray: 'tasks' | 'dependencies' | 'verificationCriteria' | null = null;

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('- id:')) {
            if (currentPhase) phases.push(currentPhase as PhaseDefinition);
            currentPhase = { id: trimmed.split('id:')[1].trim(), tasks: [] };
            currentArray = null;
          } else if (trimmed.startsWith('name:') && currentPhase) {
            currentPhase.name = trimmed.split('name:')[1].trim();
          } else if (trimmed.startsWith('description:') && currentPhase) {
            currentPhase.description = trimmed.split('description:')[1].trim();
          } else if (trimmed === 'tasks:') {
            currentArray = 'tasks';
          } else if (trimmed === 'dependencies:') {
            currentArray = 'dependencies';
          } else if (trimmed === 'verificationCriteria:') {
            currentArray = 'verificationCriteria';
          } else if (trimmed.startsWith('- ') && currentPhase && currentArray) {
            const value = trimmed.slice(2).trim();
            if (!currentPhase[currentArray]) currentPhase[currentArray] = [];
            (currentPhase[currentArray] as string[]).push(value);
          }
        }
        if (currentPhase) phases.push(currentPhase as PhaseDefinition);
        plan = { phases };
      } else {
        throw new Error('Unsupported file format. Please upload JSON or YAML.');
      }

      setPhasePlan(plan);
      setPhaseStatuses(plan.phases.map(p => ({
        id: p.id,
        name: p.name,
        status: 'pending',
        progress: 0,
      })));

      // Add system message
      const systemMsg: Message = {
        id: `sys-${Date.now()}`,
        role: 'system',
        content: `📋 Phase plan loaded: ${plan.phases.length} phases`,
        timestamp: Date.now(),
      };
      setMessages(prev => [...prev, systemMsg]);
    } catch (error) {
      console.error('Failed to load phase plan:', error);
      const errorMsg: Message = {
        id: `sys-${Date.now()}`,
        role: 'system',
        content: `❌ Failed to load phase plan: ${error instanceof Error ? error.message : 'Unknown error'}`,
        timestamp: Date.now(),
        error: error instanceof Error ? error.message : undefined,
      };
      setMessages(prev => [...prev, errorMsg]);
    }
  }, []);

  // Send message to production agent backend
  const sendMessage = useCallback(async (userContent: string) => {
    if (!userContent.trim() || isRunning) return;

    const userMsg: Message = {
      id: `usr-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      role: 'user',
      content: userContent,
      timestamp: Date.now(),
    };

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsRunning(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    let currentAssistantId: string | null = null;

    try {
      const headers: Record<string, string> = { 
        'Content-Type': 'application/json'
      };
      
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }

      const requestBody: any = {
        goal: userContent,
        model: selectedModel,
        providerId: selectedProviderId,
      };

      if (phasePlan) {
        requestBody.phasePlan = phasePlan;
      }

      const res = await fetch('/api/production-agent', {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify(requestBody),
      });

      if (!res.ok || !res.body) {
        let msg = `Request failed: status ${res.status}`;
        try {
          const j = await res.json();
          if (j?.error) msg = j.error;
        } catch {
          /* non-json */
        }
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;

          const eventMatch = line.match(/^event: (.+)$/m);
          const dataMatch = line.match(/^data: (.+)$/m);
          
          if (!eventMatch || !dataMatch) continue;

          const event = eventMatch[1];
          const data = dataMatch[1];

          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }

          // Handle different event types
          switch (event) {
            case 'system':
              const sysMsg: Message = {
                id: `sys-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
                role: 'system',
                content: parsed.content,
                timestamp: Date.now(),
              };
              setMessages(prev => [...prev, sysMsg]);
              break;

            case 'plan_loaded':
              // Plan loaded event
              break;

            case 'phase_started':
              setCurrentPhaseId(parsed.phaseId);
              setPhaseStatuses(prev => prev.map(p => 
                p.id === parsed.phaseId ? { ...p, status: 'running' } : p
              ));
              // Create new assistant message for this phase
              currentAssistantId = `ast-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
              const phaseMsg: Message = {
                id: currentAssistantId,
                role: 'assistant',
                content: '',
                timestamp: Date.now(),
                streaming: true,
                phaseId: parsed.phaseId,
              };
              setMessages(prev => [...prev, phaseMsg]);
              break;

            case 'task_started':
              if (currentAssistantId) {
                setMessages(prev => prev.map(m => 
                  m.id === currentAssistantId 
                    ? { ...m, task: parsed.task, stageLabel: `Executing: ${parsed.task}` }
                    : m
                ));
              }
              break;

            case 'stage':
              if (currentAssistantId) {
                setMessages(prev => prev.map(m => 
                  m.id === currentAssistantId 
                    ? { ...m, stage: parsed.stage, stageLabel: parsed.detail || parsed.stage }
                    : m
                ));
              }
              break;

            case 'delta':
              if (currentAssistantId) {
                setMessages(prev => prev.map(m => 
                  m.id === currentAssistantId 
                    ? { ...m, content: m.content + parsed.content, streaming: true }
                    : m
                ));
              }
              break;

            case 'tool_call':
              if (currentAssistantId) {
                setMessages(prev => prev.map(m => 
                  m.id === currentAssistantId 
                    ? { ...m, toolCalls: [...(m.toolCalls || []), parsed.tool] }
                    : m
                ));
              }
              break;

            case 'task_completed':
              if (currentAssistantId) {
                setMessages(prev => prev.map(m => 
                  m.id === currentAssistantId 
                    ? { ...m, streaming: false, stage: undefined, stageLabel: undefined }
                    : m
                ));
              }
              break;

            case 'phase_completed':
              setPhaseStatuses(prev => prev.map(p => 
                p.id === parsed.phaseId ? { ...p, status: 'completed', progress: 100 } : p
              ));
              if (currentAssistantId) {
                setMessages(prev => prev.map(m => 
                  m.id === currentAssistantId 
                    ? { ...m, streaming: false, stage: undefined, stageLabel: undefined }
                    : m
                ));
              }
              currentAssistantId = null;
              break;

            case 'awaiting_approval':
              setAwaitingApproval({
                phaseId: parsed.phaseId,
                phaseName: parsed.phaseName,
                nextPhase: parsed.nextPhase,
              });
              setPhaseStatuses(prev => prev.map(p => 
                p.id === parsed.phaseId ? { ...p, status: 'awaiting_approval' } : p
              ));
              setIsRunning(false);
              break;

            case 'phase_error':
              setPhaseStatuses(prev => prev.map(p => 
                p.id === parsed.phaseId ? { ...p, status: 'error' } : p
              ));
              break;

            case 'error':
              throw new Error(parsed.error);
          }
        }
      }

      setIsRunning(false);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        setIsRunning(false);
        return;
      }
      console.error('Failed to send message:', err);
      const errorMsg: Message = {
        id: `sys-${Date.now()}`,
        role: 'system',
        content: `❌ Error: ${err?.message || String(err)}`,
        timestamp: Date.now(),
        error: err?.message || String(err),
      };
      setMessages(prev => [...prev, errorMsg]);
      setIsRunning(false);
    } finally {
      abortControllerRef.current = null;
    }
  }, [isRunning, selectedModel, authToken, selectedProviderId, phasePlan]);

  // Stop current agent execution
  const stopAgent = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsRunning(false);
  }, []);

  // Handle form submit
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !isRunning) {
      await sendMessage(input);
    }
  };

  // Toggle message expansion
  const toggleExpanded = (id: string) => {
    setExpandedMessages(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Copy message content
  const copyMessage = (id: string, content: string) => {
    navigator.clipboard.writeText(content);
    setCopiedMessageId(id);
    setTimeout(() => setCopiedMessageId(null), 2000);
  };

  // Get phase status icon
  const getPhaseIcon = (status: PhaseStatus['status']) => {
    switch (status) {
      case 'completed':
        return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
      case 'running':
        return <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />;
      case 'awaiting_approval':
        return <Clock className="w-4 h-4 text-blue-400" />;
      case 'error':
        return <AlertCircle className="w-4 h-4 text-red-400" />;
      default:
        return <Activity className="w-4 h-4 text-zinc-500" />;
    }
  };

  /* Parked. `page.tsx` only mounts this component when the mode is selected and
   * always passes isEnabled={true}, so this panel is what Production Mode is in
   * this release — see src/app/api/production-agent/route.ts for the matching
   * 410 on the server side. */
  if (isEnabled) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-center space-y-8 max-w-3xl mx-auto"
        >
          {/* Warning Icon */}
          <div className="relative inline-block">
            <div className="absolute inset-0 -m-4 bg-amber-500/10 blur-2xl" />
            <div className="relative w-20 h-20 rounded-2xl bg-gradient-to-br from-amber-500/20 to-orange-500/20 border border-amber-500/30 flex items-center justify-center backdrop-blur-xl">
              <Rocket className="w-9 h-9 text-amber-400" />
            </div>
          </div>
          
          {/* Title */}
          <div className="space-y-3">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-medium tracking-wide uppercase">
              <Clock className="w-3 h-3" />
              Coming soon
            </span>
            <h2 className="text-3xl font-semibold text-white tracking-tight">
              Production Agent Mode
            </h2>
            <p className="text-zinc-400 text-sm max-w-xl mx-auto leading-relaxed">
              This mode is not part of the current release. It is designed to run
              a long, autonomous build in isolated phases, pausing for your
              approval between them — and it is not finished enough to trust with
              a real project, so it is switched off rather than shipped half-built.
            </p>
          </div>

          {/* What's Coming */}
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-6 text-left">
            <h3 className="text-sm font-semibold text-zinc-300 mb-4 flex items-center gap-2 uppercase tracking-wide">
              <Rocket className="w-4 h-4 text-amber-400" />
              Planned for this mode
            </h3>
            <ul className="space-y-2.5 text-sm text-zinc-400">
              <li className="flex items-start gap-2">
                <Clock className="w-4 h-4 text-zinc-500 mt-0.5 flex-shrink-0" />
                <span>WebContainer sandbox environment for safe code execution</span>
              </li>
              <li className="flex items-start gap-2">
                <Clock className="w-4 h-4 text-zinc-500 mt-0.5 flex-shrink-0" />
                <span>Full development lifecycle with automated testing</span>
              </li>
              <li className="flex items-start gap-2">
                <Clock className="w-4 h-4 text-zinc-500 mt-0.5 flex-shrink-0" />
                <span>Enterprise-grade security and audit trails</span>
              </li>
              <li className="flex items-start gap-2">
                <Clock className="w-4 h-4 text-zinc-500 mt-0.5 flex-shrink-0" />
                <span>Multi-phase project execution with approval gates</span>
              </li>
            </ul>
          </div>

          {/* Supported Providers Info */}
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-6 text-left">
            <h3 className="text-sm font-semibold text-zinc-300 mb-4 uppercase tracking-wide">
              Need a provider for the other modes?
            </h3>
            <p className="text-sm text-zinc-400 mb-4">
              Chat, Cowork, Deep Cowork and Ultra all work today. They need an API
              key from any OpenAI-compatible provider — these two are quick to set up:
            </p>
            <div className="space-y-3">
              <div className="bg-zinc-800/50 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-white">AgentRouter</span>
                  <a
                    href="https://agentrouter.org/register?aff=93bZ"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs px-2 py-1 bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 rounded border border-blue-500/40 transition-colors flex items-center gap-1"
                  >
                    Sign Up <ChevronRight className="w-3 h-3" />
                  </a>
                </div>
                <p className="text-xs text-zinc-400">Multi-model AI gateway with automatic routing</p>
              </div>
              
              <div className="bg-zinc-800/50 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-white">APINeX</span>
                  <a
                    href="https://apinex.bond/overview"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs px-2 py-1 bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 rounded border border-purple-500/40 transition-colors flex items-center gap-1"
                  >
                    Sign Up <ChevronRight className="w-3 h-3" />
                  </a>
                </div>
                <p className="text-xs text-zinc-400 mb-2">Referral Code: <code className="font-mono text-purple-400">8N7BA6PK</code></p>
                <p className="text-xs text-zinc-400">Premium API aggregation service</p>
              </div>
            </div>
          </div>

          {/* Actions */}
          {/* One action, and it does what it says. There used to be a second
            * "View Roadmap" button here that called
            * window.open('https://github.com') — the bare GitHub homepage, not a
            * roadmap and not this project. A button that lies about where it
            * goes is worse than no button. */}
          <div className="flex justify-center">
            <button
              onClick={() => onToggle(false)}
              className="px-6 py-3 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl font-medium border border-zinc-700 transition-colors"
            >
              Back to Chat
            </button>
          </div>

          {/* Additional Note */}
          <p className="text-xs text-zinc-500 max-w-xl mx-auto leading-relaxed">
            <span className="text-violet-400 font-medium">Deep Cowork</span> and{' '}
            <span className="text-amber-400 font-medium">Ultra</span> already do
            autonomous multi-file work with a plan you approve before anything is
            written. They are the closest thing available today.
          </p>
        </motion.div>
      </div>
    );
  }

  /* `page.tsx` renders this component only when the mode is active, and always
   * passes isEnabled={true}, so the branch above always returns. This is the
   * fallback for any other caller.
   *
   * Everything below this point used to be a second `return (...)` — 236 lines
   * of chat transcript, phase timeline and approval-gate JSX for the unfinished
   * agent loop. It was unreachable, it still shipped to every visitor's browser,
   * and it was the reason the production build failed: TypeScript does not apply
   * narrowing inside unreachable code, so an `awaitingApproval && ...` guard did
   * not count and the property reads under it were errors. It was removed rather
   * than left to rot. Reviving the mode means rebuilding that view against a
   * working endpoint — `src/lib/phaseManager.ts` is untouched and still holds
   * the planner. */
  return null;
}
