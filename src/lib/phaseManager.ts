import { advancedReActAgent, AgentContext } from './advancedReActAgent';
import { webContainerManager } from './webContainerManager';

export interface PhaseDefinition {
  id: number;
  name: string;
  description: string;
  tasks: string[];
  verification: string[];
  securityChecks: string[];
  dependencies?: number[];
  estimatedDuration?: number;
}

export interface PhaseProgress {
  phase: PhaseDefinition;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
  startTime?: number;
  endTime?: number;
  progress: number;
  currentTask?: string;
  artifacts: string[];
  violations: any[];
}

export interface PhasePlan {
  projectName: string;
  description: string;
  phases: PhaseDefinition[];
  metadata: {
    createdAt: number;
    estimatedDuration: number;
    complexity: 'low' | 'medium' | 'high';
    riskLevel: 'low' | 'medium' | 'high';
  };
}

export interface MemorySnapshot {
  phaseId: number;
  timestamp: number;
  context: AgentContext;
  fileStates: Record<string, string>;
  observations: string[];
  completedTasks: string[];
}

export class PhaseManager {
  private currentPlan: PhasePlan | null = null;
  private phaseProgress: Map<number, PhaseProgress> = new Map();
  private memorySnapshots: MemorySnapshot[] = [];
  private currentPhaseId: number = 0;
  private listeners: Map<string, Array<(data: any) => void>> = new Map();
  private isExecuting = false;

  constructor() {
    this.setupAgentListeners();
  }

  private setupAgentListeners(): void {
    // Listen to agent state changes for phase progress updates
    advancedReActAgent.onStateChange('COMPLETED', (context) => {
      this.handlePhaseCompletion(context);
    });

    advancedReActAgent.onStateChange('ERROR', (context) => {
      this.handlePhaseError(context);
    });

    advancedReActAgent.onStateChange('AWAITING_HITL', (context) => {
      this.handlePhaseInterruption(context);
    });
  }

  async loadPhasePlan(planJson: string | object): Promise<void> {
    try {
      const plan: PhasePlan = typeof planJson === 'string' 
        ? JSON.parse(planJson) 
        : planJson as PhasePlan;

      // Validate the plan structure
      this.validatePhasePlan(plan);

      this.currentPlan = plan;
      this.phaseProgress.clear();
      this.memorySnapshots = [];
      this.currentPhaseId = 0;

      // Initialize progress tracking for all phases
      plan.phases.forEach(phase => {
        this.phaseProgress.set(phase.id, {
          phase,
          status: 'pending',
          progress: 0,
          artifacts: [],
          violations: []
        });
      });

      console.log(`📋 Loaded phase plan: "${plan.projectName}" with ${plan.phases.length} phases`);
      this.emit('plan_loaded', { plan });
    } catch (error) {
      console.error('Failed to load phase plan:', error);
      throw new Error(`Invalid phase plan: ${error}`);
    }
  }

  private validatePhasePlan(plan: PhasePlan): void {
    if (!plan.projectName || !plan.phases || !Array.isArray(plan.phases)) {
      throw new Error('Plan must have projectName and phases array');
    }

    plan.phases.forEach(phase => {
      if (!phase.id || !phase.name || !phase.tasks || !Array.isArray(phase.tasks)) {
        throw new Error(`Phase ${phase.id} missing required fields: id, name, tasks`);
      }
    });

    // Check for dependency cycles
    this.checkDependencyCycles(plan.phases);
  }

  private checkDependencyCycles(phases: PhaseDefinition[]): void {
    const visited = new Set<number>();
    const recursionStack = new Set<number>();

    const hasCycle = (phaseId: number): boolean => {
      if (recursionStack.has(phaseId)) return true;
      if (visited.has(phaseId)) return false;

      visited.add(phaseId);
      recursionStack.add(phaseId);

      const phase = phases.find(p => p.id === phaseId);
      if (phase?.dependencies) {
        for (const dep of phase.dependencies) {
          if (hasCycle(dep)) return true;
        }
      }

      recursionStack.delete(phaseId);
      return false;
    };

    phases.forEach(phase => {
      if (hasCycle(phase.id)) {
        throw new Error('Circular dependency detected in phase plan');
      }
    });
  }

  async startExecution(): Promise<void> {
    if (!this.currentPlan) {
      throw new Error('No phase plan loaded');
    }

    if (this.isExecuting) {
      throw new Error('Phase execution already in progress');
    }

    this.isExecuting = true;
    console.log('🚀 Starting phase plan execution...');
    
    try {
      // Initialize WebContainer for the project
      await webContainerManager.initialize();
      
      // Execute phases in sequence
      for (const phase of this.currentPlan.phases) {
        await this.executePhase(phase);
        
        // Wait for human approval before proceeding (except for last phase)
        if (phase.id < this.currentPlan.phases.length) {
          await this.waitForPhaseApproval(phase.id);
        }
      }

      console.log('🎉 All phases completed successfully!');
      this.emit('execution_completed', { plan: this.currentPlan });
    } catch (error) {
      console.error('Phase execution failed:', error);
      this.emit('execution_failed', { error, phaseId: this.currentPhaseId });
    } finally {
      this.isExecuting = false;
    }
  }

  private async executePhase(phase: PhaseDefinition): Promise<void> {
    console.log(`📍 Executing Phase ${phase.id}: ${phase.name}`);
    
    this.currentPhaseId = phase.id;
    const progress = this.phaseProgress.get(phase.id)!;
    
    // Update phase status
    progress.status = 'running';
    progress.startTime = Date.now();
    this.emit('phase_started', { phase, progress });

    // Create memory snapshot before starting
    await this.createMemorySnapshot(phase.id);

    try {
      // Check dependencies
      await this.checkPhaseDependencies(phase);

      // Execute each task in the phase
      for (let i = 0; i < phase.tasks.length; i++) {
        const task = phase.tasks[i];
        progress.currentTask = task;
        progress.progress = (i / phase.tasks.length) * 100;
        
        console.log(`🎯 Executing task: ${task}`);
        this.emit('task_started', { phase, task, progress: progress.progress });

        // Execute the task using the ReAct agent
        await advancedReActAgent.startGoal(task, 1, 5);
        
        // Wait for completion or intervention
        await this.waitForAgentCompletion();

        // Collect artifacts
        const artifacts = await this.collectPhaseArtifacts(phase.id);
        progress.artifacts.push(...artifacts);

        this.emit('task_completed', { phase, task, artifacts });
      }

      // Run verification steps
      await this.runPhaseVerification(phase);

      // Mark phase as completed
      progress.status = 'completed';
      progress.endTime = Date.now();
      progress.progress = 100;
      
      console.log(`✅ Phase ${phase.id} completed successfully`);
      this.emit('phase_completed', { phase, progress });

    } catch (error) {
      progress.status = 'failed';
      progress.endTime = Date.now();
      console.error(`❌ Phase ${phase.id} failed:`, error);
      this.emit('phase_failed', { phase, error });
      throw error;
    }
  }

  private async checkPhaseDependencies(phase: PhaseDefinition): Promise<void> {
    if (!phase.dependencies) return;

    for (const depId of phase.dependencies) {
      const depProgress = this.phaseProgress.get(depId);
      if (!depProgress || depProgress.status !== 'completed') {
        throw new Error(`Phase ${phase.id} dependency not met: Phase ${depId} not completed`);
      }
    }
  }

  private async waitForAgentCompletion(): Promise<void> {
    return new Promise((resolve, reject) => {
      const checkStatus = () => {
        if (!advancedReActAgent.isActive()) {
          const context = advancedReActAgent.getContext();
          if (context.state === 'COMPLETED') {
            resolve();
          } else if (context.state === 'ERROR') {
            reject(new Error('Agent execution failed'));
          } else if (context.state === 'AWAITING_HITL') {
            // Phase paused for human intervention
            resolve();
          } else {
            // Check again in a bit
            setTimeout(checkStatus, 1000);
          }
        } else {
          setTimeout(checkStatus, 1000);
        }
      };
      checkStatus();
    });
  }

  private async runPhaseVerification(phase: PhaseDefinition): Promise<void> {
    if (!phase.verification || phase.verification.length === 0) return;

    console.log(`🔍 Running verification for Phase ${phase.id}`);
    
    for (const verification of phase.verification) {
      console.log(`Verifying: ${verification}`);
      
      // Execute verification using the agent
      await advancedReActAgent.startGoal(`Verify: ${verification}`, 1, 3);
      await this.waitForAgentCompletion();
      
      const context = advancedReActAgent.getContext();
      if (context.state === 'ERROR') {
        throw new Error(`Verification failed: ${verification}`);
      }
    }
  }

  private async collectPhaseArtifacts(phaseId: number): Promise<string[]> {
    // Collect generated/modified files as artifacts
    try {
      const files = await webContainerManager.listDirectory('.');
      return files.filter(file => !file.includes('node_modules'));
    } catch (error) {
      console.warn('Failed to collect artifacts:', error);
      return [];
    }
  }

  private async createMemorySnapshot(phaseId: number): Promise<void> {
    try {
      const context = advancedReActAgent.getContext();
      
      // Capture current file states (simplified)
      const fileStates: Record<string, string> = {};
      
      const snapshot: MemorySnapshot = {
        phaseId,
        timestamp: Date.now(),
        context: { ...context },
        fileStates,
        observations: [...context.observations],
        completedTasks: []
      };

      this.memorySnapshots.push(snapshot);
      
      // Keep only recent snapshots to manage memory
      if (this.memorySnapshots.length > 10) {
        this.memorySnapshots = this.memorySnapshots.slice(-10);
      }

      console.log(`💾 Memory snapshot created for Phase ${phaseId}`);
    } catch (error) {
      console.warn('Failed to create memory snapshot:', error);
    }
  }

  private async waitForPhaseApproval(phaseId: number): Promise<void> {
    console.log(`⏸️ Waiting for approval to proceed from Phase ${phaseId}`);
    
    return new Promise((resolve) => {
      const approvalListener = (data: { phaseId: number }) => {
        if (data.phaseId === phaseId) {
          this.off('phase_approved', approvalListener);
          resolve();
        }
      };
      
      this.on('phase_approved', approvalListener);
      this.emit('awaiting_approval', { phaseId });
    });
  }

  // Event handling
  private handlePhaseCompletion(context: AgentContext): void {
    console.log('Phase task completed successfully');
  }

  private handlePhaseError(context: AgentContext): void {
    const progress = this.phaseProgress.get(this.currentPhaseId);
    if (progress) {
      progress.violations.push({
        type: 'execution_error',
        message: context.errors.join('; '),
        timestamp: Date.now()
      });
    }
  }

  private handlePhaseInterruption(context: AgentContext): void {
    const progress = this.phaseProgress.get(this.currentPhaseId);
    if (progress) {
      progress.status = 'paused';
      progress.violations.push(...context.securityViolations);
    }
  }

  // Public API
  approvePhase(phaseId: number): void {
    this.emit('phase_approved', { phaseId });
  }

  getCurrentPhase(): PhaseDefinition | null {
    if (!this.currentPlan) return null;
    return this.currentPlan.phases.find(p => p.id === this.currentPhaseId) || null;
  }

  getPhaseProgress(phaseId: number): PhaseProgress | null {
    return this.phaseProgress.get(phaseId) || null;
  }

  getAllProgress(): PhaseProgress[] {
    return Array.from(this.phaseProgress.values());
  }

  getMemorySnapshots(): MemorySnapshot[] {
    return [...this.memorySnapshots];
  }

  isCurrentlyExecuting(): boolean {
    return this.isExecuting;
  }

  // Event system
  on(event: string, callback: (data: any) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);
  }

  off(event: string, callback: (data: any) => void): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  private emit(event: string, data: any): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error(`Event callback error for ${event}:`, error);
        }
      });
    }
  }
}

// Singleton instance
export const phaseManager = new PhaseManager();