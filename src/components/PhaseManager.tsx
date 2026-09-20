/**
 * Phase Manager UI Component
 * Renders phase plans, tracks execution progress, manages gates
 */
"use client";

import { useState, useEffect } from "react";
import { 
  CheckCircle2, 
  Circle, 
  Play, 
  Pause, 
  Clock, 
  AlertTriangle, 
  FileText,
  ChevronRight,
  ChevronDown,
  Upload,
  Download
} from "lucide-react";
import { Phase, PhasePlan, PhaseEngine, PhaseEngineState, phaseEngine } from "@/lib/phaseEngine";

interface PhaseManagerProps {
  onPhaseUpdate?: (phase: Phase) => void;
  onPlanLoad?: (plan: PhasePlan) => void;
}

export default function PhaseManager({ onPhaseUpdate, onPlanLoad }: PhaseManagerProps) {
  const [engineContext, setEngineContext] = useState(phaseEngine.getContext());
  const [expandedPhases, setExpandedPhases] = useState<Set<string>>(new Set());
  const [uploadingPlan, setUploadingPlan] = useState(false);

  useEffect(() => {
    const unsubscribe = phaseEngine.subscribe(setEngineContext);
    return unsubscribe;
  }, []);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploadingPlan(true);
    try {
      const text = await file.text();
      let plan: PhasePlan;

      if (file.name.endsWith('.json')) {
        plan = JSON.parse(text);
      } else if (file.name.endsWith('.md') || file.name.endsWith('.yaml')) {
        // Parse markdown/yaml phase plans
        plan = parseMarkdownPlan(text);
      } else {
        throw new Error('Unsupported file format. Use .json, .md, or .yaml');
      }

      // Add metadata if missing
      if (!plan.created_at) plan.created_at = new Date().toISOString();
      if (!plan.updated_at) plan.updated_at = new Date().toISOString();
      
      // Initialize phase statuses
      plan.phases.forEach(phase => {
        if (!phase.status) phase.status = 'pending';
        phase.tasks = phase.tasks.map((task, index) => ({
          id: `${phase.phase_id}_task_${index}`,
          text: typeof task === 'string' ? task : task,
          completed: false
        }));
      });

      phaseEngine.loadPlan(plan);
      onPlanLoad?.(plan);
    } catch (error) {
      console.error('Failed to load plan:', error);
      alert(`Failed to load plan: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setUploadingPlan(false);
    }
  };

  const parseMarkdownPlan = (markdown: string): PhasePlan => {
    // Simple markdown parser for phase plans
    const lines = markdown.split('\n');
    let plan: Partial<PhasePlan> = { phases: [] };
    let currentPhase: Partial<Phase> | null = null;
    let inTasks = false;

    for (const line of lines) {
      const trimmed = line.trim();
      
      if (trimmed.startsWith('# ')) {
        plan.project_title = trimmed.substring(2);
      } else if (trimmed.startsWith('## Phase ')) {
        if (currentPhase) {
          plan.phases!.push(currentPhase as Phase);
        }
        const phaseMatch = trimmed.match(/## Phase (\d+): (.+)/);
        if (phaseMatch) {
          currentPhase = {
            phase_id: `phase_${phaseMatch[1]}`,
            name: phaseMatch[2],
            tasks: [],
            dependencies: [],
            target_files: [],
            status: 'pending'
          };
        }
        inTasks = false;
      } else if (trimmed === '### Tasks:') {
        inTasks = true;
      } else if (trimmed.startsWith('- ') && inTasks && currentPhase) {
        currentPhase.tasks!.push({
          id: `${currentPhase.phase_id}_task_${currentPhase.tasks!.length}`,
          text: trimmed.substring(2),
          completed: false
        });
      } else if (trimmed.startsWith('**Target Files:**') && currentPhase) {
        const filesMatch = trimmed.match(/\*\*Target Files:\*\* (.+)/);
        if (filesMatch) {
          currentPhase.target_files = filesMatch[1].split(', ').map(f => f.trim());
        }
      }
    }

    if (currentPhase) {
      plan.phases!.push(currentPhase as Phase);
    }

    return plan as PhasePlan;
  };

  const togglePhaseExpansion = (phaseId: string) => {
    setExpandedPhases(prev => {
      const newSet = new Set(prev);
      if (newSet.has(phaseId)) {
        newSet.delete(phaseId);
      } else {
        newSet.add(phaseId);
      }
      return newSet;
    });
  };

  const getPhaseStatusIcon = (phase: Phase) => {
    switch (phase.status) {
      case 'completed':
        return <CheckCircle2 className="w-5 h-5 text-green-500" />;
      case 'active':
        return <Play className="w-5 h-5 text-blue-500 animate-pulse" />;
      case 'failed':
        return <AlertTriangle className="w-5 h-5 text-red-500" />;
      case 'paused':
        return <Pause className="w-5 h-5 text-yellow-500" />;
      default:
        return <Circle className="w-5 h-5 text-gray-400" />;
    }
  };

  const getStateDisplay = (state: PhaseEngineState) => {
    const stateMap = {
      [PhaseEngineState.IDLE]: { label: 'Idle', color: 'text-gray-500' },
      [PhaseEngineState.PHASE_INITIALIZATION]: { label: 'Initializing Phase', color: 'text-blue-500' },
      [PhaseEngineState.PLANNING]: { label: 'Planning', color: 'text-blue-500' },
      [PhaseEngineState.TOOL_CALLING]: { label: 'Executing Tools', color: 'text-green-500' },
      [PhaseEngineState.OBSERVING]: { label: 'Observing Results', color: 'text-yellow-500' },
      [PhaseEngineState.PHASE_VERIFICATION]: { label: 'Verifying Phase', color: 'text-orange-500' },
      [PhaseEngineState.AUDITING]: { label: 'Security Audit', color: 'text-purple-500' },
      [PhaseEngineState.AWAITING_PHASE_GATE]: { label: 'Awaiting Approval', color: 'text-yellow-600' },
      [PhaseEngineState.AWAITING_HITL]: { label: 'Human Review Required', color: 'text-red-500' },
      [PhaseEngineState.ALL_PHASES_COMPLETED]: { label: 'All Phases Complete', color: 'text-green-600' }
    };

    const stateInfo = stateMap[state] || { label: state, color: 'text-gray-500' };
    return <span className={stateInfo.color}>{stateInfo.label}</span>;
  };

  const handleStartExecution = async () => {
    if (phaseEngine.canStartExecution()) {
      await phaseEngine.startNextPhase();
    }
  };

  const handleApprovePhase = async () => {
    if (engineContext.currentState === PhaseEngineState.AWAITING_PHASE_GATE) {
      await phaseEngine.approvePhaseGate();
    }
  };

  const progress = phaseEngine.getPhaseProgress();

  return (
    <div className="w-full max-w-4xl mx-auto p-6 bg-white dark:bg-gray-900 rounded-lg shadow-lg">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
            Phase Manager
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Current State: {getStateDisplay(engineContext.currentState)}
          </p>
        </div>
        
        <div className="flex items-center gap-3">
          <input
            type="file"
            accept=".json,.md,.yaml,.yml"
            onChange={handleFileUpload}
            className="hidden"
            id="plan-upload"
            disabled={uploadingPlan}
          />
          <label
            htmlFor="plan-upload"
            className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 cursor-pointer disabled:opacity-50"
          >
            <Upload className="w-4 h-4" />
            {uploadingPlan ? 'Loading...' : 'Upload Plan'}
          </label>
          
          {engineContext.plan.phases.length > 0 && (
            <button
              onClick={handleStartExecution}
              disabled={!phaseEngine.canStartExecution()}
              className="flex items-center gap-2 px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Play className="w-4 h-4" />
              Start Execution
            </button>
          )}
        </div>
      </div>

      {engineContext.plan.project_title && (
        <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
            {engineContext.plan.project_title}
          </h3>
          {engineContext.plan.description && (
            <p className="text-gray-600 dark:text-gray-400 mb-3">
              {engineContext.plan.description}
            </p>
          )}
          <div className="flex items-center gap-4 text-sm text-gray-600 dark:text-gray-400">
            <span>Progress: {progress.completed}/{progress.total} phases</span>
            {progress.current && (
              <span>Current: {progress.current}</span>
            )}
          </div>
        </div>
      )}

      {engineContext.currentState === PhaseEngineState.AWAITING_PHASE_GATE && (
        <div className="mb-6 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="font-semibold text-yellow-800 dark:text-yellow-200">
                Phase Gate Approval Required
              </h4>
              <p className="text-sm text-yellow-700 dark:text-yellow-300">
                Phase "{engineContext.currentPhase?.name}" has completed successfully. 
                Review the changes and approve to proceed to the next phase.
              </p>
            </div>
            <button
              onClick={handleApprovePhase}
              className="px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600"
            >
              Approve & Continue
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {engineContext.plan.phases.map((phase) => (
          <div
            key={phase.phase_id}
            className={`border rounded-lg p-4 transition-all ${
              phase === engineContext.currentPhase 
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' 
                : 'border-gray-200 dark:border-gray-700'
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {getPhaseStatusIcon(phase)}
                <div>
                  <h4 className="font-semibold text-gray-900 dark:text-white">
                    {phase.name}
                  </h4>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    {phase.phase_id} • {phase.tasks.length} tasks
                    {phase.target_files.length > 0 && ` • ${phase.target_files.length} target files`}
                  </p>
                </div>
              </div>
              
              <button
                onClick={() => togglePhaseExpansion(phase.phase_id)}
                className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
              >
                {expandedPhases.has(phase.phase_id) ? (
                  <ChevronDown className="w-5 h-5" />
                ) : (
                  <ChevronRight className="w-5 h-5" />
                )}
              </button>
            </div>

            {expandedPhases.has(phase.phase_id) && (
              <div className="mt-4 space-y-3">
                {phase.description && (
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    {phase.description}
                  </p>
                )}
                
                <div>
                  <h5 className="font-medium text-gray-900 dark:text-white mb-2">Tasks:</h5>
                  <div className="space-y-1">
                    {phase.tasks.map((task) => (
                      <div key={task.id} className="flex items-center gap-2 text-sm">
                        <CheckCircle2 
                          className={`w-4 h-4 ${
                            task.completed ? 'text-green-500' : 'text-gray-400'
                          }`} 
                        />
                        <span className={task.completed ? 'line-through text-gray-500' : ''}>
                          {task.text}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {phase.target_files.length > 0 && (
                  <div>
                    <h5 className="font-medium text-gray-900 dark:text-white mb-2">Target Files:</h5>
                    <div className="flex flex-wrap gap-1">
                      {phase.target_files.map((file) => (
                        <span
                          key={file}
                          className="px-2 py-1 bg-gray-100 dark:bg-gray-800 text-xs rounded"
                        >
                          {file}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {phase.verification_command && (
                  <div>
                    <h5 className="font-medium text-gray-900 dark:text-white mb-2">Verification:</h5>
                    <code className="text-sm bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">
                      {phase.verification_command}
                    </code>
                  </div>
                )}

                {phase.dependencies.length > 0 && (
                  <div>
                    <h5 className="font-medium text-gray-900 dark:text-white mb-2">Dependencies:</h5>
                    <div className="flex flex-wrap gap-1">
                      {phase.dependencies.map((dep) => (
                        <span
                          key={dep}
                          className="px-2 py-1 bg-yellow-100 dark:bg-yellow-900/20 text-xs rounded"
                        >
                          {dep}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {phase.started_at && (
                  <div className="flex gap-4 text-xs text-gray-500">
                    {phase.started_at && (
                      <span>Started: {new Date(phase.started_at).toLocaleString()}</span>
                    )}
                    {phase.completed_at && (
                      <span>Completed: {new Date(phase.completed_at).toLocaleString()}</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {engineContext.plan.phases.length === 0 && (
        <div className="text-center py-8 text-gray-500">
          <FileText className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p>No phase plan loaded. Upload a plan to get started.</p>
        </div>
      )}
    </div>
  );
}