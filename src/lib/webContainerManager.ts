import { WebContainer, FileSystemTree } from '@webcontainer/api';

export interface TerminalOutput {
  type: 'stdout' | 'stderr';
  data: string;
  timestamp: number;
}

export interface ExecutionResult {
  exitCode: number;
  output: TerminalOutput[];
  duration: number;
}

export class WebContainerManager {
  private container: WebContainer | null = null;
  private isInitialized = false;
  private initPromise: Promise<void> | null = null;

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._initialize();
    return this.initPromise;
  }

  private async _initialize(): Promise<void> {
    // WebContainer only works in browser
    if (typeof window === 'undefined') {
      console.log('⏸️ WebContainer initialization skipped (SSR context)');
      return;
    }

    // Check for crossOriginIsolated requirement
    if (!crossOriginIsolated) {
      console.warn('⚠️ WebContainer requires crossOriginIsolated mode. Check your HTTP headers.');
      throw new Error('WebContainer requires crossOriginIsolated mode. Ensure Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers are set.');
    }

    try {
      console.log('🚀 Initializing WebContainer...');
      this.container = await WebContainer.boot();
      console.log('✅ WebContainer initialized successfully');
      this.isInitialized = true;
    } catch (error) {
      console.error('❌ WebContainer initialization failed:', error);
      throw new Error(`WebContainer boot failed: ${error}`);
    }
  }

  async mountFiles(files: FileSystemTree): Promise<void> {
    if (!this.container) throw new Error('WebContainer not initialized');
    
    console.log('📁 Mounting files to WebContainer VFS...');
    await this.container.mount(files);
    console.log('✅ Files mounted successfully');
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (!this.container) throw new Error('WebContainer not initialized');
    
    await this.container.fs.writeFile(path, content);
  }

  async readFile(path: string): Promise<string> {
    if (!this.container) throw new Error('WebContainer not initialized');
    
    const content = await this.container.fs.readFile(path, 'utf-8');
    return content;
  }

  async listDirectory(path: string = '.'): Promise<string[]> {
    if (!this.container) throw new Error('WebContainer not initialized');
    
    const entries = await this.container.fs.readdir(path, { withFileTypes: true });
    return entries.map(entry => {
      const name = typeof entry === 'string' ? entry : entry.name;
      const type = typeof entry === 'string' ? 'unknown' : entry.isDirectory() ? 'dir' : 'file';
      return `${type === 'dir' ? '📁' : '📄'} ${name}`;
    });
  }

  async executeCommand(command: string, args: string[] = []): Promise<ExecutionResult> {
    if (!this.container) throw new Error('WebContainer not initialized');
    
    const startTime = Date.now();
    const output: TerminalOutput[] = [];

    console.log(`⚡ Executing: ${command} ${args.join(' ')}`);
    
    const process = await this.container.spawn(command, args);

    // Capture stdout
    process.output.pipeTo(new WritableStream({
      write(data) {
        const text = new TextDecoder().decode(data);
        output.push({
          type: 'stdout',
          data: text,
          timestamp: Date.now()
        });
        console.log('📤 stdout:', text);
      }
    }));

    const exitCode = await process.exit;
    const duration = Date.now() - startTime;

    console.log(`✅ Command completed with exit code: ${exitCode} (${duration}ms)`);
    
    return { exitCode, output, duration };
  }

  async installDependencies(): Promise<ExecutionResult> {
    console.log('📦 Installing npm dependencies...');
    return this.executeCommand('npm', ['install']);
  }

  async runTests(): Promise<ExecutionResult> {
    console.log('🧪 Running tests...');
    return this.executeCommand('npm', ['test']);
  }

  async buildProject(): Promise<ExecutionResult> {
    console.log('🏗️ Building project...');
    return this.executeCommand('npm', ['run', 'build']);
  }

  getContainer(): WebContainer | null {
    return this.container;
  }

  isReady(): boolean {
    return this.isInitialized && this.container !== null;
  }

  async dispose(): Promise<void> {
    if (this.container) {
      console.log('🛑 Disposing WebContainer...');
      await this.container.teardown();
      this.container = null;
      this.isInitialized = false;
      this.initPromise = null;
    }
  }
}

// Singleton instance
export const webContainerManager = new WebContainerManager();