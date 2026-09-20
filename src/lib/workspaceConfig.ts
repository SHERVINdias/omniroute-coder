import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";

export interface DiscoveredProject {
  name: string;
  path: string;
  hasPackageJson: boolean;
}

export interface WorkspaceConfig {
  activeWorkspace: string;
}

const CONFIG_FILENAME = ".omniroute-config.json";

/**
 * Returns the absolute path to the local configuration file in process.cwd().
 */
export function getConfigFilePath(): string {
  return path.join(process.cwd(), CONFIG_FILENAME);
}

/**
 * Retrieves the currently active workspace directory path.
 * Checks .omniroute-config.json first; falls back to process.cwd() if invalid or unconfigured.
 */
export function getActiveWorkspacePath(): string {
  try {
    const configPath = getConfigFilePath();
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      const config: WorkspaceConfig = JSON.parse(raw);
      if (
        config.activeWorkspace &&
        typeof config.activeWorkspace === "string" &&
        fs.existsSync(config.activeWorkspace) &&
        fs.statSync(config.activeWorkspace).isDirectory()
      ) {
        return path.resolve(config.activeWorkspace);
      }
    }
  } catch {
    // Fall back if config file read fails
  }
  return path.resolve(process.cwd());
}

/**
 * Persists the chosen workspace path into .omniroute-config.json.
 */
export function setActiveWorkspacePath(targetPath: string): {
  success: boolean;
  activeWorkspace: string;
  error?: string;
} {
  try {
    const resolvedPath = path.resolve(targetPath);
    if (!fs.existsSync(resolvedPath)) {
      return {
        success: false,
        activeWorkspace: getActiveWorkspacePath(),
        error: `Directory "${targetPath}" does not exist.`,
      };
    }

    const stat = fs.statSync(resolvedPath);
    if (!stat.isDirectory()) {
      return {
        success: false,
        activeWorkspace: getActiveWorkspacePath(),
        error: `Target path "${targetPath}" is a file, not a directory.`,
      };
    }

    const configPath = getConfigFilePath();
    let existingConfig: Record<string, unknown> = {};

    if (fs.existsSync(configPath)) {
      try {
        existingConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      } catch {
        existingConfig = {};
      }
    }

    existingConfig.activeWorkspace = resolvedPath;
    fs.writeFileSync(
      configPath,
      JSON.stringify(existingConfig, null, 2),
      "utf-8",
    );

    return {
      success: true,
      activeWorkspace: resolvedPath,
    };
  } catch (err: unknown) {
    const errorMessage =
      err instanceof Error ? err.message : "Failed to set active workspace.";
    return {
      success: false,
      activeWorkspace: getActiveWorkspacePath(),
      error: errorMessage,
    };
  }
}

/**
 * Opens a native OS directory picker dialog using platform-specific commands.
 */
export function openNativeFolderPicker(): string | null {
  const platform = os.platform();

  try {
    if (platform === "win32") {
      const psCommand = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select Target Project Workspace Directory'; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }"`;
      const result = execSync(psCommand, {
        encoding: "utf-8",
        timeout: 30000,
      }).trim();
      return result && fs.existsSync(result) ? result : null;
    } else if (platform === "darwin") {
      const osaCommand = `osascript -e 'POSIX path of (choose folder with prompt "Select Target Project Workspace Directory")'`;
      const result = execSync(osaCommand, {
        encoding: "utf-8",
        timeout: 30000,
      }).trim();
      return result && fs.existsSync(result) ? result : null;
    } else if (platform === "linux") {
      const zenityCommand = `zenity --file-selection --directory --title="Select Target Project Workspace Directory"`;
      const result = execSync(zenityCommand, {
        encoding: "utf-8",
        timeout: 30000,
      }).trim();
      return result && fs.existsSync(result) ? result : null;
    }
  } catch {
    // Return null if OS dialog is canceled or unavailable
  }

  return null;
}

const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".vscode",
  ".idea",
  "dist",
  "build",
  "coverage",
  "AppData",
  "Library",
  "Application Data",
  "Local Settings",
  "$Recycle.Bin",
  "System Volume Information",
  "temp",
  "tmp",
  ".venv",
  "venv",
  "__pycache__",
]);

/**
 * Background scanner that recursively scans Home Directory, Downloads,
 * and common user project folders for subfolders containing package.json files.
 */
export async function scanDiscoveredProjects(): Promise<DiscoveredProject[]> {
  const homeDir = os.homedir();
  const searchRoots = [
    homeDir,
    path.join(homeDir, "Downloads"),
    path.join(homeDir, "Documents"),
    path.join(homeDir, "Desktop"),
    path.join(homeDir, "Projects"),
    path.join(homeDir, "workspace"),
    path.join(homeDir, "code"),
    path.join(homeDir, "dev"),
    process.cwd(),
  ].filter(
    (dirPath) => fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory(),
  );

  const discoveredMap = new Map<string, DiscoveredProject>();

  function inspectDirectory(
    currentDir: string,
    currentDepth: number,
    maxDepth: number,
  ) {
    if (currentDepth > maxDepth) return;

    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      const pkgPath = path.join(currentDir, "package.json");
      if (fs.existsSync(pkgPath) && fs.statSync(pkgPath).isFile()) {
        let projectName = path.basename(currentDir);
        try {
          const pkgRaw = fs.readFileSync(pkgPath, "utf-8");
          const pkgData = JSON.parse(pkgRaw);
          if (pkgData.name && typeof pkgData.name === "string") {
            projectName = pkgData.name;
          }
        } catch {
          // Fall back to folder name if package.json read/parse fails
        }

        const normalizedPath = path.resolve(currentDir);
        discoveredMap.set(normalizedPath, {
          name: projectName,
          path: normalizedPath,
          hasPackageJson: true,
        });
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dirName = entry.name;
        if (dirName.startsWith(".") || IGNORED_DIR_NAMES.has(dirName)) continue;

        const subDir = path.join(currentDir, dirName);
        inspectDirectory(subDir, currentDepth + 1, maxDepth);
      }
    } catch {
      // Ignore permission or read errors
    }
  }

  for (const rootPath of searchRoots) {
    inspectDirectory(rootPath, 0, 2);
  }

  return Array.from(discoveredMap.values());
}
