"use client";

import React, { useState, useEffect } from "react";
import { X, Settings as SettingsIcon, Info, Key, CheckCircle, XCircle, Loader2, Eye, EyeOff, BadgeCheck, Plus, Trash2, Edit2, Check, AlertTriangle, Terminal } from "lucide-react";
import { ProviderConfig } from "@/lib/credentialManager";
import GatewaySetupWizard from "./GatewaySetupWizard";
/* providerProfiles is deliberately dependency-free (no node: imports, no db),
 * so a client component can import it without dragging the server bundle in. */
import {
  PROVIDER_PROFILES,
  getProviderProfile,
  allowsEmptyApiKey,
  incompatibleProviderWarning,
} from "@/lib/providerProfiles";

export interface RoundSettings {
  startIterations: number;
  ceilingIterations: number;
  extendAmount: number;
  stallTolerance: number;
  repeatLimit: number;
  accountRetries: number;
  planStartIterations: number;
  planCeilingIterations: number;
}

export interface AgentRouterSettings {
  authScheme: "bearer" | "x-api-key";
  modelDiscovery: boolean;
  default1MContext: boolean;
  showEstimatedCost: boolean;
  proxyUrl: string;
  proxyPacUrl: string;
}

const DEFAULT_AGENT_ROUTER_SETTINGS: AgentRouterSettings = {
  authScheme: "bearer",
  modelDiscovery: true,
  default1MContext: false,
  showEstimatedCost: false,
  proxyUrl: "",
  proxyPacUrl: "",
};

type ConnectionStatus = "idle" | "testing" | "success" | "error";

/**
 * A fresh provider form.
 *
 * The base URL is pre-filled from the default profile so the most common case
 * (the local gateway) is one click away, and every reset goes through this
 * helper rather than through four separate object literals that drifted.
 *
 * It is a function, not a constant, so no two resets share the same modelIds
 * array.
 */
function blankProviderForm(): Partial<ProviderConfig> {
  const defaultProfile = getProviderProfile("omniroute");
  return {
    name: "",
    provider: defaultProfile.id,
    apiKey: "",
    baseUrl: defaultProfile.baseUrlPlaceholder,
    modelIds: [],
  };
}

interface ConnectionState {
  status: ConnectionStatus;
  message: string;
}

const DEFAULT_SETTINGS: RoundSettings = {
  startIterations: 12,
  ceilingIterations: 150,
  extendAmount: 3,
  stallTolerance: 120,
  repeatLimit: 10,
  accountRetries: 2,
  planStartIterations: 8,
  planCeilingIterations: 16,
};

const SETTINGS_KEY = "omniroute_round_settings";

/**
 * Ultra's role overrides.
 *
 * Empty string means "decide automatically", and that is the default on
 * purpose. The pipeline picks a reviewer that differs from the model which
 * wrote the code, and always falls back to the model it knows answered — so
 * leaving these blank gives a cross-model audit without anyone configuring
 * anything, and setting one is an override rather than a requirement.
 *
 * Pinning a model here is not free: if its quota is exhausted the review costs
 * one failed request before falling back. That is the cost of a guarantee.
 */
export interface RoleModelSettings {
  /** Model for Ultra's independent review pass. "" = auto. */
  reviewModel: string;
  /** How many review -> fix cycles Ultra may spend. 0 = server default. */
  maxReviewCycles: number;
}

const DEFAULT_ROLE_MODELS: RoleModelSettings = {
  reviewModel: "",
  maxReviewCycles: 0,
};

const ROLE_MODELS_KEY = "omniroute_role_models";

export function loadRoleModels(): RoleModelSettings {
  if (typeof window === "undefined") return DEFAULT_ROLE_MODELS;
  try {
    const stored = localStorage.getItem(ROLE_MODELS_KEY);
    if (stored) {
      return { ...DEFAULT_ROLE_MODELS, ...JSON.parse(stored) };
    }
  } catch (e) {
    console.error("Failed to load role models:", e);
  }
  return DEFAULT_ROLE_MODELS;
}

export function saveRoleModels(settings: RoleModelSettings): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(ROLE_MODELS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error("Failed to save role models:", e);
  }
}

/** Minimal shape needed to render the picker; matches /api/models catalog. */
export interface ModelChoice {
  id: string;
  label: string;
  isCombo: boolean;
}

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (settings: RoundSettings) => void;
  onProviderChange?: () => void; // Callback when providers are modified
  /** Catalog for the reviewer picker. Optional so existing callers compile. */
  modelCatalog?: ModelChoice[];
  /** Fired when the Ultra role overrides change. */
  onRoleModelsSave?: (settings: RoleModelSettings) => void;
}

export function loadSettings(): RoundSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
    }
  } catch (e) {
    console.error("Failed to load settings:", e);
  }
  return DEFAULT_SETTINGS;
}

export function saveSettings(settings: RoundSettings): void {
  if (typeof window === "undefined") return;
  
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error("Failed to save settings:", e);
  }
}

export function loadAgentRouterSettings(providerKey: string): AgentRouterSettings {
  if (typeof window === "undefined" || !providerKey) return DEFAULT_AGENT_ROUTER_SETTINGS;
  try {
    const stored = localStorage.getItem(`agent_router_${providerKey}`);
    if (stored) {
      return { ...DEFAULT_AGENT_ROUTER_SETTINGS, ...JSON.parse(stored) };
    }
  } catch (e) {
    console.error("Failed to load agent router settings:", e);
  }
  return DEFAULT_AGENT_ROUTER_SETTINGS;
}

export function saveAgentRouterSettings(providerKey: string, settings: AgentRouterSettings): void {
  if (typeof window === "undefined" || !providerKey) return;
  try {
    localStorage.setItem(`agent_router_${providerKey}`, JSON.stringify(settings));
  } catch (e) {
    console.error("Failed to save agent router settings:", e);
  }
}

/**
 * Does this base URL point somewhere only the server itself can reach?
 *
 * Deliberately a cheap textual check, not a resolver: this only decides whether
 * to show an explanatory note while someone types. The authoritative refusal is
 * `isPubliclyRoutable` in src/lib/ssrfGuard.ts, which resolves the hostname —
 * because a public name can resolve to 127.0.0.1 and no string test would catch
 * it. Being occasionally silent here is fine; being wrong there would not be.
 */
function looksPrivateHost(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  /* `new URL("http://[::1]:1234").hostname` keeps the brackets, so strip them
   * before any IPv6 comparison. */
  const bare = host.replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  /* mDNS. Resolves only on the typist's own LAN, never from a server. */
  if (host.endsWith(".local")) return true;

  if (bare === "::1" || bare === "::") return true;
  /* Only for things that are actually IPv6 literals. Without the colon test,
   * `/^f[cd]/` would flag ordinary hostnames like `fcm.googleapis.com`, and a
   * warning that cries wolf on a public domain is worse than no warning. */
  if (bare.includes(":")) {
    /* Link-local (fe80::/10) and unique-local (fc00::/7, i.e. fc.. and fd..). */
    if (/^fe[89ab]/.test(bare)) return true;
    if (/^f[cd]/.test(bare)) return true;
  }

  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  /* 0.0.0.0/8 — "this network". Reaches the server's own interfaces. */
  if (/^0\./.test(host)) return true;
  /* Carrier-grade NAT, 100.64.0.0/10. This is the range Tailscale hands out,
   * so it is the private address a user is most likely to paste *without*
   * realising it is private — which is exactly why the textual check has to
   * know about it. The server refuses it either way (ssrfGuard.ts), so
   * omitting it here only meant the refusal arrived as an empty model list
   * instead of as an explanation. */
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true;
  /* Multicast and reserved, 224.0.0.0/4 and 240.0.0.0/4. */
  if (/^(22[4-9]|2[3-5]\d)\./.test(host)) return true;
  return false;
}

export default function SettingsPanel({ isOpen, onClose, onSave, onProviderChange, modelCatalog, onRoleModelsSave }: SettingsPanelProps) {
  const [settings, setSettings] = useState<RoundSettings>(DEFAULT_SETTINGS);
  const [roleModels, setRoleModels] = useState<RoleModelSettings>(DEFAULT_ROLE_MODELS);
  const [hasChanges, setHasChanges] = useState(false);
  
  // Provider management state
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  /* Whether this deployment will fetch loopback/private base URLs at all.
   *
   * Defaults to TRUE so that nothing is warned about until the server has
   * actually said otherwise — a false default would flash a scary notice on
   * every load of a local install, which is the common case. */
  const [privateGatewayAllowed, setPrivateGatewayAllowed] = useState(true);
  const [editingProvider, setEditingProvider] = useState<ProviderConfig | null>(null);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>({ status: "idle", message: "" });
  const [showApiKey, setShowApiKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  /* The guided gateway setup. Lives here rather than in page.tsx because this
   * is where someone lands when they go looking for "where do I put my key",
   * which is the moment the wizard is worth offering. */
  const [showGatewayWizard, setShowGatewayWizard] = useState(false);

  // Form state for add/edit provider
  const [formData, setFormData] = useState<Partial<ProviderConfig>>(blankProviderForm);

  const [agentRouterSettings, setAgentRouterSettings] = useState<AgentRouterSettings>(DEFAULT_AGENT_ROUTER_SETTINGS);

  // Ollama control state
  const [ollamaModels, setOllamaModels] = useState<any[]>([]);
  const [ollamaLoading, setOllamaLoading] = useState(false);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [ollamaToggles, setOllamaToggles] = useState<Record<string, boolean>>({});

  /* The profile behind the currently-selected provider type. Everything the
   * form needs to adapt — placeholder URL, whether a key is required, whether
   * a model list exists — comes from here rather than from hardcoded strings,
   * so adding a provider to the registry adds it to this form too. */
  const activeProfile = getProviderProfile(formData.provider || "omniroute");
  const keyIsOptional = allowsEmptyApiKey(activeProfile, formData.baseUrl || "");
  const incompatibleWarning = incompatibleProviderWarning(activeProfile);

  useEffect(() => {
    if (isOpen) {
      const loaded = loadSettings();
      setSettings(loaded);
      setRoleModels(loadRoleModels());
      setHasChanges(false);
      loadProviders();
    }
  }, [isOpen]);

  const loadProviders = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/credentials");
      const data = await response.json();
      if (data.success) {
        setProviders(data.data.providers || []);
        setActiveProviderId(data.data.activeProviderId || null);
        /* Sibling key, not part of `data.data`. Compared against `false`
         * explicitly so that an older server that does not send the field at
         * all leaves the permissive default in place. */
        setPrivateGatewayAllowed(data.privateGatewayAllowed !== false);
      }
    } catch (error) {
      console.error("Failed to load providers:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (key: keyof RoundSettings, value: string) => {
    const numValue = parseInt(value, 10);
    if (!isNaN(numValue) && numValue >= 0) {
      setSettings((prev) => ({ ...prev, [key]: numValue }));
      setHasChanges(true);
    }
  };

  const handleFormChange = (field: keyof ProviderConfig, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    setConnectionState({ status: "idle", message: "" });
  };

  /**
   * Switching provider type rewrites the fields the user has not personalised.
   *
   * "Not personalised" means empty, or still equal to some preset's own value —
   * that way picking Ollama after OpenAI replaces api.openai.com/v1 with
   * localhost:11434/v1, but a URL the user actually typed is never clobbered.
   *
   * Custom is excluded from URL pre-fill on purpose: its placeholder
   * (api.provider.com) is an illustration, not a reachable host, and filling it
   * in would look like a working default.
   */
  const handleProviderTypeChange = (providerId: string) => {
    const nextProfile = getProviderProfile(providerId);

    setFormData((prev) => {
      const currentUrl = (prev.baseUrl || "").trim();
      const currentName = (prev.name || "").trim();

      const urlIsPreset =
        currentUrl === "" ||
        PROVIDER_PROFILES.some((p) => p.baseUrlPlaceholder === currentUrl);
      const nameIsPreset =
        currentName === "" || PROVIDER_PROFILES.some((p) => p.label === currentName);

      return {
        ...prev,
        provider: providerId,
        baseUrl:
          urlIsPreset && nextProfile.id !== "custom"
            ? nextProfile.baseUrlPlaceholder
            : prev.baseUrl,
        name: nameIsPreset ? nextProfile.label : prev.name,
        /* Model ids are provider-specific. Carrying `gpt-4o` over to an Ollama
         * provider would put an unreachable id in the picker. */
        modelIds: [],
      };
    });

    setConnectionState({ status: "idle", message: "" });
  };

  const handleTestConnection = async () => {
    if (!formData.baseUrl) {
      setConnectionState({ status: "error", message: "Enter a Base URL first" });
      return;
    }
    /* A key is only mandatory for providers that actually authenticate. Local
     * servers (Ollama, LM Studio, llama.cpp) are reachable without one, and
     * blocking the test here is what used to make them unconfigurable. */
    if (!formData.apiKey && !keyIsOptional && !editingProvider) {
      setConnectionState({
        status: "error",
        message: `${activeProfile.label} needs an API key.`,
      });
      return;
    }

    setConnectionState({ status: "testing", message: "Testing connection..." });
    try {
      const response = await fetch("/api/credentials/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: formData.apiKey || "",
          baseUrl: formData.baseUrl,
          /* Without the provider type the server cannot know which auth header
           * or path suffix to use, and would fall back to Bearer + /v1. */
          provider: formData.provider || "omniroute",
          /* Providers with no model-list endpoint are probed with a one-token
           * completion instead, which needs a model name to aim at. */
          ...(formData.modelIds && formData.modelIds.length > 0
            ? { model: formData.modelIds[0] }
            : {}),
          ...(editingProvider?.id ? { id: editingProvider.id } : {}),
        }),
      });
      const data = await response.json();

      if (data.success) {
        setConnectionState({
          status: "success",
          message: data.message || "Connection successful!",
        });
      } else {
        setConnectionState({ status: "error", message: data.error || "Connection failed" });
      }
    } catch (error) {
      setConnectionState({ status: "error", message: "Failed to test connection" });
    }
  };

  const handleSaveProvider = async () => {
    if (!formData.name || !formData.provider || !formData.baseUrl) {
      setConnectionState({ status: "error", message: "Name, provider type and Base URL are required" });
      return;
    }
    /* Creating a keyed provider still requires a key; editing one does not,
     * because a blank key means "keep the stored one" on the server. */
    if (!editingProvider && !formData.apiKey && !keyIsOptional) {
      setConnectionState({
        status: "error",
        message: `${activeProfile.label} needs an API key.`,
      });
      return;
    }

    setSaving(true);
    try {
      const response = await fetch("/api/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editingProvider?.id,
          name: formData.name,
          provider: formData.provider,
          /* Blank is meaningful: on update it preserves the stored key, and on
           * create it is how a keyless local server is saved. */
          apiKey: formData.apiKey || "",
          baseUrl: formData.baseUrl,
          modelIds: formData.modelIds || [],
        }),
      });
      const data = await response.json();

      if (data.success) {
        // Find the saved provider id to use as cache key
        const savedProviderList = data.data.providers as ProviderConfig[];
        const savedProvider = savedProviderList.find(p => p.name === formData.name && p.provider === formData.provider);
        if (savedProvider && formData.provider === "agentrouter") {
          saveAgentRouterSettings(savedProvider.id!, agentRouterSettings);
        }

        setConnectionState({
          status: data.warning ? "error" : "success",
          message:
            data.warning ||
            (editingProvider ? "Provider updated!" : "Provider added!"),
        });
        await loadProviders();
        setIsAddingNew(false);
        setEditingProvider(null);
        setFormData(blankProviderForm());
        setAgentRouterSettings(DEFAULT_AGENT_ROUTER_SETTINGS);
        if (onProviderChange) onProviderChange();
      } else {
        setConnectionState({ status: "error", message: data.error || "Failed to save provider" });
      }
    } catch (error) {
      setConnectionState({ status: "error", message: "Failed to save provider" });
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteProvider = async (providerId: string) => {
    if (!confirm("Are you sure you want to delete this provider?")) return;

    try {
      const response = await fetch(`/api/credentials?id=${providerId}`, { method: "DELETE" });
      const data = await response.json();

      if (data.success) {
        await loadProviders();
        if (onProviderChange) onProviderChange();
      }
    } catch (error) {
      console.error("Failed to delete provider:", error);
    }
  };

  const handleSetActive = async (providerId: string) => {
    try {
      const response = await fetch("/api/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeProviderId: providerId }),
      });
      const data = await response.json();

      if (data.success) {
        setActiveProviderId(providerId);
        if (onProviderChange) onProviderChange();
      }
    } catch (error) {
      console.error("Failed to set active provider:", error);
    }
  };

  const startEditing = (provider: ProviderConfig) => {
    setEditingProvider(provider);
    setFormData({
      name: provider.name,
      provider: provider.provider,
      /* Blank on purpose. The list endpoint returns a masked preview, never a
       * usable key, so there is nothing real to put here — and a blank key on
       * update tells the server to keep the one it already has. */
      apiKey: "",
      baseUrl: provider.baseUrl,
      modelIds: provider.modelIds || [],
    });
    setAgentRouterSettings(loadAgentRouterSettings(provider.id!));
    setIsAddingNew(false);
    setConnectionState({ status: "idle", message: "" });
  };

  const startAdding = () => {
    setIsAddingNew(true);
    setEditingProvider(null);
    setFormData(blankProviderForm());
    setAgentRouterSettings(DEFAULT_AGENT_ROUTER_SETTINGS);
    setConnectionState({ status: "idle", message: "" });
  };

  const cancelEditing = () => {
    setIsAddingNew(false);
    setEditingProvider(null);
    setFormData(blankProviderForm());
    setConnectionState({ status: "idle", message: "" });
  };

  const handleSave = () => {
    saveSettings(settings);
    onSave(settings);
    saveRoleModels(roleModels);
    onRoleModelsSave?.(roleModels);
    setHasChanges(false);
    onClose();
  };

  const handleReset = () => {
    setSettings(DEFAULT_SETTINGS);
    setRoleModels(DEFAULT_ROLE_MODELS);
    setHasChanges(true);
  };

  // Ollama control functions
  const loadOllamaModels = async () => {
    setOllamaLoading(true);
    setOllamaError(null);
    try {
      // Find Ollama providers
      const ollamaProviders = providers.filter(p => 
        p.provider === "ollama" || 
        p.provider?.toLowerCase().includes("ollama") || 
        p.baseUrl?.includes("11434")
      );
      console.log("[loadOllamaModels] Found Ollama providers:", ollamaProviders.map(p => ({ name: p.name, provider: p.provider, baseUrl: p.baseUrl })));

      if (ollamaProviders.length === 0) {
        setOllamaError("No Ollama providers configured");
        setOllamaModels([]);
        return;
      }

      // Use the first Ollama provider's base URL
      const baseUrl = ollamaProviders[0].baseUrl?.replace(/\/v1\/?$/, "") || "http://localhost:11434";

      const response = await fetch("/api/ollama/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "status", baseUrl }),
      });

      const data = await response.json();

      if (data.success) {
        setOllamaModels(data.models || []);
        // Initialize toggles - all loaded models are "on"
        const toggles: Record<string, boolean> = {};
        data.models.forEach((model: any) => {
          toggles[model.name] = true;
        });
        setOllamaToggles(toggles);
      } else {
        setOllamaError(data.error || "Failed to get Ollama status");
        setOllamaModels([]);
      }
    } catch (error: any) {
      setOllamaError(error.message || "Failed to connect to Ollama");
      setOllamaModels([]);
    } finally {
      setOllamaLoading(false);
    }
  };

  const toggleOllamaModel = async (modelName: string, shouldLoad: boolean) => {
    try {
      const ollamaProviders = providers.filter(p => 
        p.provider === "ollama" || p.baseUrl?.includes("11434")
      );

      if (ollamaProviders.length === 0) return;

      const baseUrl = ollamaProviders[0].baseUrl?.replace(/\/v1\/?$/, "") || "http://localhost:11434";

      const response = await fetch("/api/ollama/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: shouldLoad ? "load" : "unload",
          model: modelName,
          baseUrl,
        }),
      });

      const data = await response.json();

      if (data.success) {
        setOllamaToggles(prev => ({ ...prev, [modelName]: shouldLoad }));
        // Reload the status to get updated list
        await loadOllamaModels();
      } else {
        setOllamaError(data.error || "Failed to control model");
        // Revert toggle on error
        setOllamaToggles(prev => ({ ...prev, [modelName]: !shouldLoad }));
      }
    } catch (error: any) {
      setOllamaError(error.message || "Failed to control model");
      // Revert toggle on error
      setOllamaToggles(prev => ({ ...prev, [modelName]: !shouldLoad }));
    }
  };

  const unloadAllOllamaModels = async () => {
    if (ollamaModels.length === 0) return;

    setOllamaLoading(true);
    try {
      // Unload each model
      for (const model of ollamaModels) {
        await toggleOllamaModel(model.name, false);
      }
    } finally {
      setOllamaLoading(false);
    }
  };

  // Load Ollama models when panel opens
  useEffect(() => {
    if (isOpen && providers.length > 0) {
      const hasOllama = providers.some(p => 
        p.provider === "ollama" || p.baseUrl?.includes("11434")
      );
      if (hasOllama) {
        loadOllamaModels();
      }
    }
  }, [isOpen, providers]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-neutral-900 border border-neutral-800 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-neutral-800">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center">
              <SettingsIcon className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">Settings</h2>
              <p className="text-xs text-zinc-500">Configure API providers and execution parameters</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-zinc-400 hover:text-zinc-200 hover:bg-neutral-800 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* API Providers Section */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Key className="w-4 h-4 text-amber-400" />
                <h3 className="text-sm font-semibold text-zinc-200 uppercase tracking-wide">API Providers</h3>
              </div>
              {!isAddingNew && !editingProvider && (
                <div className="flex items-center gap-2">
                  {/* The guided path, offered before the manual one. Someone who
                    * has never run the gateway cannot fill in "Base URL", and
                    * "Add Provider" gives them no way to find out what it is. */}
                  <button
                    onClick={() => setShowGatewayWizard(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-lg text-zinc-200 text-sm font-medium transition-colors"
                    title="Step-by-step setup for a gateway running on your own machine"
                  >
                    <Terminal className="w-4 h-4 text-amber-400" />
                    Set up gateway
                  </button>
                  <button
                    onClick={startAdding}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/30 rounded-lg text-amber-200 text-sm font-medium transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    Add Provider
                  </button>
                </div>
              )}
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 text-amber-400 animate-spin" />
              </div>
            ) : (
              <>
                {/* Provider List */}
                {!isAddingNew && !editingProvider && (
                  <div className="space-y-2">
                    {providers.length === 0 ? (
                      <div className="bg-neutral-800/50 border border-neutral-700 rounded-lg p-6 text-center">
                        <Key className="w-8 h-8 text-zinc-600 mx-auto mb-2" />
                        <p className="text-sm text-zinc-400">No providers configured</p>
                        <p className="text-xs text-zinc-500 mt-1 max-w-sm mx-auto leading-relaxed">
                          The usual setup is the OmniRoute gateway running on your
                          own machine. The wizard walks through installing it,
                          unlocking its dashboard and pointing this app at it.
                        </p>
                        <button
                          onClick={() => setShowGatewayWizard(true)}
                          className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/30 rounded-lg text-amber-200 text-sm font-medium transition-colors"
                        >
                          <Terminal className="w-4 h-4" />
                          Set up my gateway
                        </button>
                      </div>
                    ) : (
                      providers.map((provider) => (
                        <div
                          key={provider.id}
                          className={`bg-neutral-800/50 border rounded-lg p-4 transition-all ${
                            provider.id === activeProviderId
                              ? "border-amber-500/50 bg-amber-500/5"
                              : "border-neutral-700 hover:border-neutral-600"
                          }`}
                        >
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                <h4 className="text-sm font-semibold text-zinc-100">{provider.name}</h4>
                                {provider.id === activeProviderId && (
                                  <span className="px-2 py-0.5 bg-amber-500/20 border border-amber-500/30 rounded text-xs font-medium text-amber-200">
                                    Active
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-zinc-500 mt-1">
                                {provider.provider} • {provider.baseUrl}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              {provider.id !== activeProviderId && (
                                <button
                                  onClick={() => handleSetActive(provider.id)}
                                  className="p-1.5 text-zinc-400 hover:text-amber-200 hover:bg-amber-500/10 rounded transition-colors"
                                  title="Set as active"
                                >
                                  <Check className="w-4 h-4" />
                                </button>
                              )}
                              <button
                                onClick={() => startEditing(provider)}
                                className="p-1.5 text-zinc-400 hover:text-violet-200 hover:bg-violet-500/10 rounded transition-colors"
                                title="Edit"
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => handleDeleteProvider(provider.id)}
                                className="p-1.5 text-zinc-400 hover:text-red-200 hover:bg-red-500/10 rounded transition-colors"
                                title="Delete"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {/* Add/Edit Provider Form */}
                {(isAddingNew || editingProvider) && (
                  <div className="bg-neutral-800/50 border border-neutral-700 rounded-lg p-4 space-y-4">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-semibold text-zinc-100">
                        {editingProvider ? "Edit Provider" : "Add New Provider"}
                      </h4>
                      <button
                        onClick={cancelEditing}
                        className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>

                    {/* Provider Name */}
                    <div className="space-y-2">
                      <label className="block text-sm font-medium text-zinc-300">
                        Provider Name
                        <span className="text-red-400 ml-1">*</span>
                      </label>
                      <input
                        type="text"
                        value={formData.name || ""}
                        onChange={(e) => handleFormChange("name", e.target.value)}
                        placeholder="e.g., My OmniRoute Account"
                        className="w-full px-3 py-2 bg-neutral-900/50 border border-neutral-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500/50 transition-colors"
                      />
                    </div>

                    {/* Provider Type */}
                    <div className="space-y-2">
                      <label className="block text-sm font-medium text-zinc-300">
                        Provider Type
                        <span className="text-red-400 ml-1">*</span>
                      </label>
                      <select
                        value={formData.provider || "omniroute"}
                        onChange={(e) => handleProviderTypeChange(e.target.value)}
                        className="w-full px-3 py-2 bg-neutral-900/50 border border-neutral-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500/50 transition-colors"
                      >
                        <optgroup label="Gateway">
                          {PROVIDER_PROFILES.filter((p) => p.kind === "gateway").map((p) => (
                            <option key={p.id} value={p.id}>{p.label}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Local models (no API key needed)">
                          {PROVIDER_PROFILES.filter((p) => p.kind === "local").map((p) => (
                            <option key={p.id} value={p.id}>{p.label}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Hosted providers">
                          {PROVIDER_PROFILES.filter((p) => p.kind === "external").map((p) => (
                            <option key={p.id} value={p.id}>{p.label}</option>
                          ))}
                        </optgroup>
                      </select>
                      {activeProfile.notes && (
                        <p className="text-xs text-zinc-500 leading-relaxed">{activeProfile.notes}</p>
                      )}
                      {incompatibleWarning && (
                        <p className="text-xs text-amber-400 leading-relaxed">{incompatibleWarning}</p>
                      )}
                    </div>

                    {/* API Key */}
                    <div className="space-y-2">
                      <label className="block text-sm font-medium text-zinc-300">
                        API Key
                        {keyIsOptional ? (
                          <span className="text-xs text-zinc-500 ml-2 font-normal">Optional for local servers</span>
                        ) : (
                          <span className="text-red-400 ml-1">*</span>
                        )}
                      </label>
                      <div className="relative">
                        <input
                          type={showApiKey ? "text" : "password"}
                          value={formData.apiKey || ""}
                          onChange={(e) => handleFormChange("apiKey", e.target.value)}
                          placeholder={
                            editingProvider
                              ? "Current key is saved (leave unchanged to keep)"
                              : keyIsOptional
                                ? "Leave blank — this server needs no key"
                                : "Enter your API key"
                          }
                          className="w-full px-3 py-2 pr-10 bg-neutral-900/50 border border-neutral-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500/50 transition-colors"
                        />
                        <button
                          type="button"
                          onClick={() => setShowApiKey(!showApiKey)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-zinc-400 hover:text-zinc-200 transition-colors"
                        >
                          {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                      {/* Shown while the field is blank during an edit: that is
                          exactly the state in which the stored key survives. */}
                      {editingProvider && !formData.apiKey && (
                        <p className="text-xs text-green-400 flex items-center gap-1">
                          <span className="inline-block w-1 h-1 bg-green-400 rounded-full"></span>
                          Current API key is saved and will be preserved unless you type a new one
                        </p>
                      )}
                      {editingProvider && formData.apiKey && (
                        <p className="text-xs text-amber-400 flex items-center gap-1">
                          <span className="inline-block w-1 h-1 bg-amber-400 rounded-full"></span>
                          Saving will replace the stored API key
                        </p>
                      )}
                    </div>

                    {/* Base URL */}
                    <div className="space-y-2">
                      <label className="block text-sm font-medium text-zinc-300">
                        Base URL
                        <span className="text-red-400 ml-1">*</span>
                      </label>
                      <input
                        type="text"
                        value={formData.baseUrl || ""}
                        onChange={(e) => handleFormChange("baseUrl", e.target.value)}
                        placeholder={activeProfile.baseUrlPlaceholder}
                        className="w-full px-3 py-2 bg-neutral-900/50 border border-neutral-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500/50 transition-colors"
                      />

                      {/* Shown only on a deployment that refuses private
                        * targets, and only once what has been typed is one.
                        *
                        * This is the most confusing failure the app has. The
                        * user pictures their browser calling their gateway; the
                        * call is actually made by the SERVER, so `localhost`
                        * means the server's own loopback. Without this note the
                        * symptom is "No Providers Connected" and an empty model
                        * list, which reads as a broken gateway rather than as a
                        * property of where the app is running.
                        *
                        * The authoritative refusal is isPubliclyRoutable() in
                        * src/lib/ssrfGuard.ts. This is only an early heads-up. */}
                      {!privateGatewayAllowed && looksPrivateHost(formData.baseUrl || "") && (
                        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                          <div className="text-xs text-amber-200/90 leading-relaxed space-y-1">
                            <p>
                              This server will not fetch loopback or private
                              addresses. The request to your gateway is made by{" "}
                              <span className="font-semibold text-amber-200">the server</span>, not by your
                              browser — so{" "}
                              <code className="px-1 rounded bg-black/30 text-amber-100">localhost</code>{" "}
                              here means the server, not your computer. Saving
                              this will produce an empty model list.
                            </p>
                            <p>
                              To use a gateway on your own machine, give it a
                              public address first — for example{" "}
                              <code className="px-1 rounded bg-black/30 text-amber-100">
                                cloudflared tunnel --url http://localhost:20128
                              </code>{" "}
                              — and paste the https URL it prints.
                            </p>
                            {/* The one case where a tunnel is the wrong answer,
                              * called out here because the symptom is identical
                              * and the fix is not. "Set up gateway" detects it;
                              * this text is for anyone typing the URL by hand. */}
                            <p>
                              Exception: if this app is running in Docker on the
                              same machine as the gateway, no tunnel is needed —
                              use{" "}
                              <code className="px-1 rounded bg-black/30 text-amber-100">
                                http://host.docker.internal:20128/v1
                              </code>{" "}
                              and set{" "}
                              <code className="px-1 rounded bg-black/30 text-amber-100">
                                OMNIROUTE_ALLOW_PRIVATE_GATEWAY=true
                              </code>
                              . Use <span className="font-semibold text-amber-200">Set up gateway</span>{" "}
                              above and it will work out which of these applies.
                            </p>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Manual model ids — the only way to populate the picker
                        for providers with no catalogue endpoint (Azure). */}
                    <div className="space-y-2">
                      <label className="block text-sm font-medium text-zinc-300">
                        Model IDs
                        <span className="text-xs text-zinc-500 ml-2 font-normal">
                          {activeProfile.supportsModelList
                            ? "Optional — added alongside the models this provider reports"
                            : "Required — this provider does not publish a model list"}
                        </span>
                      </label>
                      <input
                        type="text"
                        value={(formData.modelIds || []).join(", ")}
                        onChange={(e) =>
                          setFormData((prev) => ({
                            ...prev,
                            modelIds: e.target.value
                              .split(",")
                              .map((m) => m.trim())
                              .filter(Boolean),
                          }))
                        }
                        placeholder={activeProfile.modelHint ? `${activeProfile.modelHint}, ...` : "model-one, model-two"}
                        className="w-full px-3 py-2 bg-neutral-900/50 border border-neutral-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500/50 transition-colors"
                      />
                    </div>

                    {/* Agent Router Specific Settings */}
                    {formData.provider === "agentrouter" && (
                      <div className="pt-4 mt-4 border-t border-neutral-700 space-y-5">
                        <div>
                          <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">Agent Router Configuration</h4>
                          
                          <div className="space-y-4">
                            {/* Auth Scheme */}
                            <div className="space-y-2">
                              <label className="block text-sm font-medium text-zinc-300">
                                Gateway Auth Scheme
                                <span className="text-xs text-zinc-500 ml-2 font-normal">How credentials are sent</span>
                              </label>
                              <select
                                value={agentRouterSettings.authScheme}
                                onChange={(e) => setAgentRouterSettings(prev => ({ ...prev, authScheme: e.target.value as "bearer" | "x-api-key" }))}
                                className="w-full px-3 py-2 bg-neutral-900/50 border border-neutral-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                              >
                                <option value="bearer">bearer</option>
                                <option value="x-api-key">x-api-key</option>
                              </select>
                            </div>

                            {/* Toggles */}
                            <div className="space-y-3 pt-2">
                              {/* Model Discovery */}
                              <label className="flex items-start gap-3 cursor-pointer group">
                                <div className="relative flex items-start h-5 mt-0.5">
                                  <input
                                    type="checkbox"
                                    checked={agentRouterSettings.modelDiscovery}
                                    onChange={(e) => setAgentRouterSettings(prev => ({ ...prev, modelDiscovery: e.target.checked }))}
                                    className="peer appearance-none w-10 h-5 bg-neutral-700 rounded-full checked:bg-amber-500 transition-colors cursor-pointer"
                                  />
                                  <div className="absolute left-1 top-1 w-3 h-3 bg-white rounded-full peer-checked:translate-x-5 transition-transform pointer-events-none" />
                                </div>
                                <div>
                                  <p className="text-sm font-medium text-zinc-200 group-hover:text-white transition-colors">Model Discovery</p>
                                  <p className="text-xs text-zinc-500 mt-0.5">Auto-populate models from the gateway at launch.</p>
                                </div>
                              </label>

                              {/* Default 1M Context */}
                              <label className="flex items-start gap-3 cursor-pointer group">
                                <div className="relative flex items-start h-5 mt-0.5">
                                  <input
                                    type="checkbox"
                                    checked={agentRouterSettings.default1MContext}
                                    onChange={(e) => setAgentRouterSettings(prev => ({ ...prev, default1MContext: e.target.checked }))}
                                    className="peer appearance-none w-10 h-5 bg-neutral-700 rounded-full checked:bg-amber-500 transition-colors cursor-pointer"
                                  />
                                  <div className="absolute left-1 top-1 w-3 h-3 bg-white rounded-full peer-checked:translate-x-5 transition-transform pointer-events-none" />
                                </div>
                                <div>
                                  <p className="text-sm font-medium text-zinc-200 group-hover:text-white transition-colors">Default to 1M context</p>
                                  <p className="text-xs text-zinc-500 mt-0.5">Start picker on the 1M-context variant of the default model.</p>
                                </div>
                              </label>

                              {/* Show Estimated Cost */}
                              <label className="flex items-start gap-3 cursor-pointer group">
                                <div className="relative flex items-start h-5 mt-0.5">
                                  <input
                                    type="checkbox"
                                    checked={agentRouterSettings.showEstimatedCost}
                                    onChange={(e) => setAgentRouterSettings(prev => ({ ...prev, showEstimatedCost: e.target.checked }))}
                                    className="peer appearance-none w-10 h-5 bg-neutral-700 rounded-full checked:bg-amber-500 transition-colors cursor-pointer"
                                  />
                                  <div className="absolute left-1 top-1 w-3 h-3 bg-white rounded-full peer-checked:translate-x-5 transition-transform pointer-events-none" />
                                </div>
                                <div>
                                  <p className="text-sm font-medium text-zinc-200 group-hover:text-white transition-colors">Show estimated cost</p>
                                  <p className="text-xs text-zinc-500 mt-0.5">Show an estimated cost on the Usage page.</p>
                                </div>
                              </label>
                            </div>

                            {/* Network Proxy */}
                            <div className="pt-3 border-t border-neutral-800/50 space-y-3">
                              <h5 className="text-xs font-semibold text-zinc-400 uppercase">Network Proxy</h5>
                              
                              <div className="space-y-2">
                                <label className="block text-xs font-medium text-zinc-300">Proxy server URL</label>
                                <input
                                  type="text"
                                  value={agentRouterSettings.proxyUrl}
                                  onChange={(e) => setAgentRouterSettings(prev => ({ ...prev, proxyUrl: e.target.value }))}
                                  placeholder="http://proxy.example.com:8080"
                                  className="w-full px-3 py-2 bg-neutral-900/50 border border-neutral-700 rounded-lg text-zinc-100 text-xs focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                                />
                                <p className="text-[10px] text-zinc-500">Send HTTP requests through this proxy.</p>
                              </div>

                              <div className="space-y-2">
                                <label className="block text-xs font-medium text-zinc-300">Proxy auto-config (PAC) URL</label>
                                <input
                                  type="text"
                                  value={agentRouterSettings.proxyPacUrl}
                                  onChange={(e) => setAgentRouterSettings(prev => ({ ...prev, proxyPacUrl: e.target.value }))}
                                  placeholder="http://wpad.example.com/proxy.pac"
                                  className="w-full px-3 py-2 bg-neutral-900/50 border border-neutral-700 rounded-lg text-zinc-100 text-xs focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                                />
                                <p className="text-[10px] text-zinc-500">URL of a PAC file (wins over proxy server URL).</p>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Connection Status */}
                    {connectionState.status !== "idle" && (
                      <div className={`flex items-center gap-2 p-3 rounded-lg ${
                        connectionState.status === "success" ? "bg-green-500/10 border border-green-500/30" :
                        connectionState.status === "error" ? "bg-red-500/10 border border-red-500/30" :
                        "bg-blue-500/10 border border-blue-500/30"
                      }`}>
                        {connectionState.status === "testing" && <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />}
                        {connectionState.status === "success" && <CheckCircle className="w-4 h-4 text-green-400" />}
                        {connectionState.status === "error" && <XCircle className="w-4 h-4 text-red-400" />}
                        <p className={`text-sm ${
                          connectionState.status === "success" ? "text-green-200" :
                          connectionState.status === "error" ? "text-red-200" :
                          "text-blue-200"
                        }`}>
                          {connectionState.message}
                        </p>
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex gap-2">
                      <button
                        onClick={handleTestConnection}
                        disabled={saving || connectionState.status === "testing"}
                        className="flex-1 px-4 py-2 bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded-lg text-zinc-100 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Test Connection
                      </button>
                      <button
                        onClick={handleSaveProvider}
                        disabled={saving || connectionState.status === "testing"}
                        className="flex-1 px-4 py-2 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/30 rounded-lg text-amber-200 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                      >
                        {saving ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Saving...
                          </>
                        ) : (
                          editingProvider ? "Update Provider" : "Save Provider"
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Round Budget Settings */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <SettingsIcon className="w-4 h-4 text-violet-400" />
              <h3 className="text-sm font-semibold text-zinc-200 uppercase tracking-wide">Round Budget Settings</h3>
              <div className="flex-1 h-px bg-neutral-800" />
            </div>

            <div className="bg-violet-500/5 border border-violet-500/20 rounded-lg p-3 flex gap-2 items-start">
              <Info className="w-5 h-5 text-violet-400 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-medium text-violet-200">Round Budget Controls</p>
                <p className="text-xs text-violet-200/70 mt-1">
                  These settings control how many iterations the agent can use for tasks and plans.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="block text-sm font-medium text-zinc-300">
                  Start Iterations
                  <span className="block text-xs text-zinc-500 font-normal mt-0.5">Initial budget for tasks</span>
                </label>
                <input
                  type="number"
                  value={settings.startIterations}
                  onChange={(e) => handleChange("startIterations", e.target.value)}
                  min="1"
                  className="w-full px-3 py-2 bg-neutral-800/50 border border-neutral-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 transition-colors"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-zinc-300">
                  Ceiling Iterations
                  <span className="block text-xs text-zinc-500 font-normal mt-0.5">Maximum budget for tasks</span>
                </label>
                <input
                  type="number"
                  value={settings.ceilingIterations}
                  onChange={(e) => handleChange("ceilingIterations", e.target.value)}
                  min="1"
                  className="w-full px-3 py-2 bg-neutral-800/50 border border-neutral-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 transition-colors"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-zinc-300">
                  Extend Amount
                  <span className="block text-xs text-zinc-500 font-normal mt-0.5">Rounds added on progress</span>
                </label>
                <input
                  type="number"
                  value={settings.extendAmount}
                  onChange={(e) => handleChange("extendAmount", e.target.value)}
                  min="1"
                  className="w-full px-3 py-2 bg-neutral-800/50 border border-neutral-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 transition-colors"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-zinc-300">
                  Stall Tolerance
                  <span className="block text-xs text-zinc-500 font-normal mt-0.5">Rounds before stalling</span>
                </label>
                <input
                  type="number"
                  value={settings.stallTolerance}
                  onChange={(e) => handleChange("stallTolerance", e.target.value)}
                  min="1"
                  className="w-full px-3 py-2 bg-neutral-800/50 border border-neutral-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 transition-colors"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-zinc-300">
                  Repeat Limit
                  <span className="block text-xs text-zinc-500 font-normal mt-0.5">Max identical calls</span>
                </label>
                <input
                  type="number"
                  value={settings.repeatLimit}
                  onChange={(e) => handleChange("repeatLimit", e.target.value)}
                  min="1"
                  className="w-full px-3 py-2 bg-neutral-800/50 border border-neutral-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 transition-colors"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-zinc-300">
                  Account Retries
                  <span className="block text-xs text-zinc-500 font-normal mt-0.5">Retries on errors</span>
                </label>
                <input
                  type="number"
                  value={settings.accountRetries}
                  onChange={(e) => handleChange("accountRetries", e.target.value)}
                  min="0"
                  className="w-full px-3 py-2 bg-neutral-800/50 border border-neutral-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 transition-colors"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-zinc-300">
                  Plan Start Iterations
                  <span className="block text-xs text-zinc-500 font-normal mt-0.5">Initial budget for plans</span>
                </label>
                <input
                  type="number"
                  value={settings.planStartIterations}
                  onChange={(e) => handleChange("planStartIterations", e.target.value)}
                  min="1"
                  className="w-full px-3 py-2 bg-neutral-800/50 border border-neutral-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 transition-colors"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-zinc-300">
                  Plan Ceiling Iterations
                  <span className="block text-xs text-zinc-500 font-normal mt-0.5">Maximum budget for plans</span>
                </label>
                <input
                  type="number"
                  value={settings.planCeilingIterations}
                  onChange={(e) => handleChange("planCeilingIterations", e.target.value)}
                  min="1"
                  className="w-full px-3 py-2 bg-neutral-800/50 border border-neutral-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 transition-colors"
                />
              </div>
            </div>
          </div>

          {/* Ultra Mode */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <BadgeCheck className="w-4 h-4 text-fuchsia-400" />
              <h3 className="text-sm font-semibold text-zinc-200 uppercase tracking-wide">Ultra Mode Review</h3>
              <div className="flex-1 h-px bg-neutral-800" />
            </div>

            <div className="bg-fuchsia-500/5 border border-fuchsia-500/20 rounded-lg p-3 flex gap-2 items-start">
              <Info className="w-5 h-5 text-fuchsia-400 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-medium text-fuchsia-200">Who audits the code</p>
                <p className="text-xs text-fuchsia-200/70 mt-1">
                  Ultra runs a read-only review pass over every file it changed. Left on
                  automatic it picks a model different from the one that wrote the code, since
                  a model reviewing its own work tends to agree with itself. Pin one here only
                  if you want a specific auditor — if its quota is out, the review falls back
                  to the model that answered.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="block text-sm font-medium text-zinc-300">
                  Reviewer Model
                  <span className="block text-xs text-zinc-500 font-normal mt-0.5">Automatic picks a different model</span>
                </label>
                <select
                  value={roleModels.reviewModel}
                  onChange={(e) => {
                    setRoleModels((prev) => ({ ...prev, reviewModel: e.target.value }));
                    setHasChanges(true);
                  }}
                  className="w-full px-3 py-2 bg-neutral-800/50 border border-neutral-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-fuchsia-500/50 focus:border-fuchsia-500/50 transition-colors"
                >
                  <option value="">Automatic (recommended)</option>
                  {(modelCatalog ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                      {m.isCombo ? " (combo)" : ""}
                    </option>
                  ))}
                </select>
                {(modelCatalog ?? []).length === 0 && (
                  <p className="text-xs text-zinc-500">
                    No models loaded yet — reopen this panel once the model list has fetched.
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-zinc-300">
                  Review Cycles
                  <span className="block text-xs text-zinc-500 font-normal mt-0.5">Review → fix rounds, 0 = default</span>
                </label>
                <input
                  type="number"
                  value={roleModels.maxReviewCycles}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    if (!isNaN(n) && n >= 0 && n <= 5) {
                      setRoleModels((prev) => ({ ...prev, maxReviewCycles: n }));
                      setHasChanges(true);
                    }
                  }}
                  min="0"
                  max="5"
                  className="w-full px-3 py-2 bg-neutral-800/50 border border-neutral-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:ring-2 focus:ring-fuchsia-500/50 focus:border-fuchsia-500/50 transition-colors"
                />
              </div>
            </div>
          </div>

          {/* Local Model Control (Ollama) */}
          {providers.some(p => {
            const isOllama = p.provider === "ollama" || 
                           p.provider?.toLowerCase().includes("ollama") || 
                           p.baseUrl?.includes("11434");
            console.log("[SettingsPanel] Checking provider:", p.name, "provider:", p.provider, "baseUrl:", p.baseUrl, "isOllama:", isOllama);
            return isOllama;
          }) && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <div className="w-4 h-4 rounded bg-green-500/20 border border-green-500/30 flex items-center justify-center">
                  <div className="w-2 h-2 bg-green-400 rounded-full" />
                </div>
                <h3 className="text-sm font-semibold text-zinc-200 uppercase tracking-wide">Local Model Control</h3>
                <div className="flex-1 h-px bg-neutral-800" />
              </div>

              <div className="bg-green-500/5 border border-green-500/20 rounded-lg p-3 flex gap-2 items-start">
                <Info className="w-5 h-5 text-green-400 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-green-200">Manage Ollama Models in RAM</p>
                  <p className="text-xs text-green-200/70 mt-1">
                    Unload models from memory to free RAM when not in use. Models load automatically when needed.
                  </p>
                </div>
              </div>

              {ollamaLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 text-green-400 animate-spin" />
                </div>
              ) : ollamaError ? (
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 flex gap-2 items-start">
                  <XCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-red-200">Connection Error</p>
                    <p className="text-xs text-red-200/70 mt-1">{ollamaError}</p>
                    <button
                      onClick={loadOllamaModels}
                      className="mt-2 px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 rounded text-xs font-medium text-red-200 transition-colors"
                    >
                      Retry
                    </button>
                  </div>
                </div>
              ) : ollamaModels.length === 0 ? (
                <div className="bg-neutral-800/50 border border-neutral-700 rounded-lg p-6 text-center">
                  <div className="w-12 h-12 rounded-full bg-neutral-700/50 flex items-center justify-center mx-auto mb-3">
                    <div className="w-6 h-6 rounded-full bg-neutral-600" />
                  </div>
                  <p className="text-sm text-zinc-400">No models currently loaded in RAM</p>
                  <p className="text-xs text-zinc-500 mt-1">Models load automatically when you send a message</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Loaded Models */}
                  <div className="space-y-2">
                    {ollamaModels.map((model) => (
                      <div
                        key={model.name}
                        className="bg-neutral-800/50 border border-neutral-700 rounded-lg p-4 flex items-center justify-between"
                      >
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-green-400" />
                            <h4 className="text-sm font-semibold text-zinc-100">{model.name}</h4>
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-xs text-zinc-500">
                            <span>Size: {model.size ? `${(model.size / 1024 / 1024 / 1024).toFixed(2)} GB` : 'Unknown'}</span>
                            {model.size_vram && (
                              <span>RAM: {(model.size_vram / 1024 / 1024 / 1024).toFixed(2)} GB</span>
                            )}
                          </div>
                        </div>
                        <label className="relative flex items-center cursor-pointer group">
                          <input
                            type="checkbox"
                            checked={ollamaToggles[model.name] || false}
                            onChange={(e) => toggleOllamaModel(model.name, e.target.checked)}
                            className="peer appearance-none w-11 h-6 bg-neutral-700 rounded-full checked:bg-green-500 transition-colors cursor-pointer"
                          />
                          <div className="absolute left-1 top-1 w-4 h-4 bg-white rounded-full peer-checked:translate-x-5 transition-transform pointer-events-none" />
                          <span className="ml-3 text-xs font-medium text-zinc-400 group-hover:text-zinc-200">
                            {ollamaToggles[model.name] ? 'Loaded' : 'Unloaded'}
                          </span>
                        </label>
                      </div>
                    ))}
                  </div>

                  {/* Unload All Button */}
                  <button
                    onClick={unloadAllOllamaModels}
                    disabled={ollamaModels.length === 0}
                    className="w-full px-4 py-2 bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 rounded-lg text-red-200 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Unload All Models
                  </button>

                  {/* Refresh Button */}
                  <button
                    onClick={loadOllamaModels}
                    className="w-full px-4 py-2 bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded-lg text-zinc-100 text-sm font-medium transition-colors"
                  >
                    Refresh Status
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-5 border-t border-neutral-800 bg-neutral-900/50">
          <button
            onClick={handleReset}
            className="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200 hover:bg-neutral-800 rounded-lg transition-colors"
          >
            Reset to Defaults
          </button>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-zinc-300 hover:text-zinc-100 hover:bg-neutral-800 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!hasChanges}
              className="px-4 py-2 bg-amber-500 hover:bg-amber-600 disabled:bg-neutral-700 disabled:text-zinc-500 rounded-lg text-white text-sm font-medium transition-colors disabled:cursor-not-allowed"
            >
              Save Changes
            </button>
          </div>
        </div>
      </div>

      {/* Sibling of the settings panel, not a child of it: the panel carries
        * `overflow-hidden`, so a full-screen overlay nested inside it would be
        * clipped to the panel's rounded box. */}
      <GatewaySetupWizard
        isOpen={showGatewayWizard}
        onClose={() => setShowGatewayWizard(false)}
        onConnected={() => {
          /* Pull the new provider into this panel's own list, then tell the
           * host so the model picker reloads. Without the second call the
           * gateway is saved and active but no models appear until reload. */
          void loadProviders();
          if (onProviderChange) onProviderChange();
        }}
      />
    </div>
  );
}
