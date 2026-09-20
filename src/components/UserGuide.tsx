"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  ChevronRight,
  ChevronLeft,
  Sparkles,
  Globe,
  Cpu,
  Code2,
  Zap,
  Layers,
  Folder,
  Download,
  Settings,
  ArrowRight,
  CheckCircle,
  Copy,
  ExternalLink,
  AlertTriangle,
  Rocket,
  Users,
  Brain,
  MessageSquare,
  Terminal,
  FileCode,
  Link,
  Key,
  FileText,
  Coins,
  Info,
  ShieldCheck,
  Lock,
  FolderTree,
  Database,
} from "lucide-react";

interface UserGuideProps {
  onClose: () => void;
}

type Section =
  | "overview"
  | "deployment"
  | "providers"
  | "modes"
  | "vscode"
  | "features"
  | "troubleshooting";

export default function UserGuide({ onClose }: UserGuideProps) {
  const [activeSection, setActiveSection] = useState<Section>("overview");
  const [expandedProviders, setExpandedProviders] = useState<string[]>([]);
  const [copiedApiKey, setCopiedApiKey] = useState<string | null>(null);

  const sections = [
    { id: "overview", label: "Getting Started", icon: Rocket },
    { id: "deployment", label: "Deployment & Access", icon: Globe },
    { id: "providers", label: "Connect Providers", icon: Key },
    { id: "modes", label: "Working Modes", icon: Layers },
    { id: "vscode", label: "VS Code Extension", icon: Code2 },
    { id: "features", label: "Advanced Features", icon: Sparkles },
    { id: "troubleshooting", label: "Troubleshooting", icon: AlertTriangle },
  ];

  const toggleProvider = (provider: string) => {
    setExpandedProviders((prev) =>
      prev.includes(provider)
        ? prev.filter((p) => p !== provider)
        : [...prev, provider]
    );
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedApiKey(id);
    setTimeout(() => setCopiedApiKey(null), 2000);
  };

  const currentIndex = sections.findIndex((s) => s.id === activeSection);

  const goNext = () => {
    if (currentIndex < sections.length - 1) {
      setActiveSection(sections[currentIndex + 1].id as Section);
    }
  };

  const goPrev = () => {
    if (currentIndex > 0) {
      setActiveSection(sections[currentIndex - 1].id as Section);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.9, y: 20 }}
        transition={{ type: "spring", damping: 20, stiffness: 300 }}
        className="bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl max-w-6xl w-full max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-zinc-800 bg-gradient-to-r from-blue-600/10 to-purple-600/10">
          <div className="flex items-center gap-3">
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
            >
              <Sparkles className="w-8 h-8 text-blue-400" />
            </motion.div>
            <div>
              <h2 className="text-2xl font-bold text-white">
                OmniRoute Coder - User Guide
              </h2>
              <p className="text-sm text-zinc-400">
                Your comprehensive guide to AI-powered development
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <X className="w-6 h-6 text-zinc-400" />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar Navigation */}
          <div className="w-64 border-r border-zinc-800 bg-zinc-900/50 p-4 overflow-y-auto">
            <nav className="space-y-1">
              {sections.map((section) => {
                const Icon = section.icon;
                return (
                  <motion.button
                    key={section.id}
                    whileHover={{ x: 4 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => setActiveSection(section.id as Section)}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${
                      activeSection === section.id
                        ? "bg-blue-600 text-white shadow-lg shadow-blue-600/20"
                        : "text-zinc-400 hover:bg-zinc-800 hover:text-white"
                    }`}
                  >
                    <Icon className="w-5 h-5" />
                    <span className="text-sm font-medium">{section.label}</span>
                  </motion.button>
                );
              })}
            </nav>
          </div>

          {/* Main Content */}
          <div className="flex-1 overflow-y-auto">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeSection}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.2 }}
                className="p-8"
              >
                {activeSection === "overview" && <OverviewSection />}
                {activeSection === "deployment" && <DeploymentSection />}
                {activeSection === "providers" && (
                  <ProvidersSection
                    expandedProviders={expandedProviders}
                    toggleProvider={toggleProvider}
                    copyToClipboard={copyToClipboard}
                    copiedApiKey={copiedApiKey}
                  />
                )}
                {activeSection === "modes" && <ModesSection />}
                {activeSection === "vscode" && <VSCodeSection />}
                {activeSection === "features" && <FeaturesSection />}
                {activeSection === "troubleshooting" && (
                  <TroubleshootingSection />
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        {/* Footer Navigation */}
        <div className="flex items-center justify-between p-4 border-t border-zinc-800 bg-zinc-900/50">
          <button
            onClick={goPrev}
            disabled={currentIndex === 0}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-zinc-800 text-zinc-400"
          >
            <ChevronLeft className="w-4 h-4" />
            Previous
          </button>

          <div className="flex gap-2">
            {sections.map((section, idx) => (
              <div
                key={section.id}
                className={`w-2 h-2 rounded-full transition-all ${
                  idx === currentIndex
                    ? "bg-blue-500 w-8"
                    : idx < currentIndex
                    ? "bg-blue-500/50"
                    : "bg-zinc-700"
                }`}
              />
            ))}
          </div>

          <button
            onClick={goNext}
            disabled={currentIndex === sections.length - 1}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-zinc-800 text-zinc-400"
          >
            Next
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function OverviewSection() {
  const steps = [
    {
      icon: Globe,
      title: "Connect AI Providers",
      description:
        "Run the OmniRoute gateway on your machine, or paste a key from any hosted provider",
      color: "from-blue-500 to-cyan-500",
    },
    {
      icon: Settings,
      title: "Configure Settings",
      description: "Customize your workspace and preferences",
      color: "from-purple-500 to-pink-500",
    },
    {
      icon: MessageSquare,
      title: "Start Chatting",
      description: "Select a mode and begin your AI-assisted development",
      color: "from-green-500 to-emerald-500",
    },
    {
      icon: Code2,
      title: "Install VS Code Extension (local setup only)",
      description: "Needed for Deep Cowork file editing when you run OmniRoute on your own machine",
      color: "from-orange-500 to-red-500",
    },
  ];

  return (
    <div className="space-y-8">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center"
      >
        <h3 className="text-3xl font-bold text-white mb-4">
          Welcome to OmniRoute Coder! 🚀
        </h3>
        <p className="text-zinc-400 text-lg max-w-2xl mx-auto">
          A powerful web-based AI development environment that connects you to
          multiple AI providers. Access it through your browser - no software installation needed!
        </p>
      </motion.div>

      {/* Web Application Notice */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.2 }}
        className="bg-gradient-to-r from-blue-500/10 to-cyan-500/10 border border-blue-500/30 rounded-xl p-6"
      >
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
            <Globe className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <h4 className="text-lg font-semibold text-blue-400 mb-2">
              🌐 Web-Based Application
            </h4>
            <p className="text-zinc-300 mb-2">
              This is a <strong>web application</strong> that you access through your browser after running the .bat file. 
              Everything runs in your browser - no need to download or install anything on your PC!
            </p>
            <p className="text-zinc-400 text-sm">
              The .bat file simply starts the local server and opens your browser to http://localhost:4001
            </p>
          </div>
        </div>
      </motion.div>

      <div className="grid md:grid-cols-2 gap-6 mt-12">
        {steps.map((step, idx) => {
          const Icon = step.icon;
          return (
            <motion.div
              key={idx}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.1 + 0.3 }}
              className="relative group"
            >
              <div className="absolute inset-0 bg-gradient-to-r opacity-0 group-hover:opacity-100 rounded-xl blur-xl transition-opacity duration-500 ${step.color}" />
              <div className="relative bg-zinc-800/50 border border-zinc-700 rounded-xl p-6 hover:border-zinc-600 transition-all">
                <div
                  className={`w-12 h-12 rounded-lg bg-gradient-to-br ${step.color} flex items-center justify-center mb-4`}
                >
                  <Icon className="w-6 h-6 text-white" />
                </div>
                <h4 className="text-xl font-semibold text-white mb-2">
                  {step.title}
                </h4>
                <p className="text-zinc-400">{step.description}</p>
                <div className="absolute top-4 right-4 w-8 h-8 rounded-full bg-zinc-700 flex items-center justify-center text-sm font-bold text-white">
                  {idx + 1}
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.7 }}
        className="bg-gradient-to-r from-amber-500/10 to-orange-500/10 border border-amber-500/30 rounded-xl p-6 mt-8"
      >
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h4 className="text-lg font-semibold text-amber-400 mb-2">
              🧪 Beta Testing Notice
            </h4>
            <p className="text-zinc-300">
              You're using a beta version of OmniRoute Coder. Some features are
              still under development (like Production Mode). We appreciate your
              feedback to make this tool better!
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function DeploymentSection() {
  return (
    <div className="space-y-8">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center"
      >
        <h3 className="text-3xl font-bold text-white mb-4">
          🚀 Deploying to AWS for Beta Testing
        </h3>
        <p className="text-zinc-400 text-lg max-w-2xl mx-auto">
          Deploy OmniRoute Coder to AWS so beta testers can reach it in a
          browser — no downloads needed. This page is the shape of it;{" "}
          <code className="px-1 rounded bg-zinc-900 text-zinc-300">AWS_DEPLOYMENT_CHECKLIST.md</code>{" "}
          in the repo is the command-by-command version, and it is the one to
          follow when you actually deploy.
        </p>
      </motion.div>

      {/* Architecture Overview */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.2 }}
        className="bg-gradient-to-r from-green-500/10 to-emerald-500/10 border border-green-500/30 rounded-xl p-6"
      >
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center flex-shrink-0">
            <Globe className="w-5 h-5 text-green-400" />
          </div>
          <div>
            <h4 className="text-lg font-semibold text-green-400 mb-2">
              🌐 Web Application Architecture
            </h4>
            <p className="text-zinc-300 mb-3">
              OmniRoute Coder is a <strong>web-based application</strong>. Once deployed to AWS:
            </p>
            <ul className="space-y-2 text-zinc-300">
              <li className="flex items-start gap-2">
                <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
                <span>Users visit your URL in their browser (Chrome, Firefox, etc.)</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
                <span>Complete AI chat interface with all features</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
                <span>Beautiful animations and modern UI</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
                <span>Document export (PDF, DOCX, Markdown)</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
                <span>User authentication with email OTP</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
                <span><strong>No software installation</strong> needed for chat — the extension is optional, and only for file work</span>
              </li>
            </ul>
          </div>
        </div>
      </motion.div>

      {/* What Users Can/Cannot Do */}
      <div className="grid md:grid-cols-2 gap-6">
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.3 }}
          className="bg-zinc-800/50 border border-zinc-700 rounded-xl p-6"
        >
          <h4 className="text-xl font-semibold text-green-400 mb-4 flex items-center gap-2">
            <CheckCircle className="w-6 h-6" />
            ✅ What Beta Users Get
          </h4>
          <ul className="space-y-3 text-zinc-300">
            <li className="flex items-start gap-2">
              <span className="text-green-400">•</span>
              <span>Full web interface in browser</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-400">•</span>
              <span>Chat with AI models (using their API keys)</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-400">•</span>
              <span>Chat mode in full — streaming, attachments, exports</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-amber-400">•</span>
              <span>
                Cowork, Deep Cowork and Ultra need the{" "}
                <strong>OmniRoute VS Code extension</strong> — it is what gives
                them a folder to work in. Files are read and written{" "}
                <em>on the user&apos;s own machine</em>, never on the server
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-400">•</span>
              <span>Settings, subscriptions, token tracking</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-400">•</span>
              <span>File uploads and document exports</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-400">•</span>
              <span>Slash commands and advanced features</span>
            </li>
          </ul>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.4 }}
          className="bg-zinc-800/50 border border-red-700/50 rounded-xl p-6"
        >
          <h4 className="text-xl font-semibold text-red-400 mb-4 flex items-center gap-2">
            <AlertTriangle className="w-6 h-6" />
            ⚠️ What a hosted deployment still cannot do
          </h4>
          <ul className="space-y-3 text-zinc-300">
            <li className="flex items-start gap-2">
              <span className="text-orange-400">→</span>
              <span>
                <strong>Nothing happens without the editor open.</strong> File
                tools reach the user&apos;s VS Code or they fail — there is no
                server-side fallback in a hosted build, deliberately. Close the
                editor and Cowork says so rather than quietly working on
                something else.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-orange-400">→</span>
              <span>
                <strong>Only folders the user has approved.</strong> The
                extension asks per folder, remembers the answer, and the consent
                can be revoked from the status bar. A hosted server cannot browse
                a machine it was not invited into.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-orange-400">→</span>
              <span>
                <strong>The operator must have enabled the bridge.</strong> A
                production build refuses to open the listener unless{" "}
                <code className="px-1 rounded bg-zinc-900 text-zinc-300">OMNIROUTE_BRIDGE_ENABLE=true</code>.
                Without it, chat works and the file modes stay hidden.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-orange-400">→</span>
              <span>
                <strong>A gateway on the user&apos;s own localhost is still
                unreachable.</strong> Provider URLs are fetched by the server, so{" "}
                <code className="px-1 rounded bg-zinc-900 text-zinc-300">http://localhost:20128</code>{" "}
                resolves to the server. The bridge carries files and commands,
                not HTTP requests to other services. The fix is to give the
                gateway a public address of its own —{" "}
                <code className="px-1 rounded bg-zinc-900 text-zinc-300">cloudflared tunnel --url http://localhost:20128</code>{" "}
                — and paste that https address, plus{" "}
                <code className="px-1 rounded bg-zinc-900 text-zinc-300">/v1</code>,
                as the Base URL. Settings → Set up gateway does this with you.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-zinc-500">•</span>
              <span className="text-zinc-400">
                This panel used to say the opposite — that the extension could
                only ever talk to a bridge on{" "}
                <code className="px-1 rounded bg-zinc-900 text-zinc-400">127.0.0.1</code>,
                so a hosted server could never reach a tester&apos;s laptop. That
                was true of the old design. The extension now dials{" "}
                <em>outward</em> to the server over wss and authenticates with a
                per-account token.
              </span>
            </li>
          </ul>
        </motion.div>
      </div>

      {/* Deployment Steps */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5 }}
        className="bg-zinc-800/50 border border-zinc-700 rounded-xl p-6"
      >
        <h4 className="text-2xl font-semibold text-white mb-6 flex items-center gap-2">
          <Rocket className="w-6 h-6 text-blue-400" />
          Quick AWS Deployment Guide
        </h4>

        <div className="space-y-6">
          {/* Step 1: Launch EC2 */}
          <div className="pl-6 border-l-2 border-blue-500">
            <h5 className="text-lg font-semibold text-blue-400 mb-2">
              Step 1: Launch EC2 Instance
            </h5>
            <ul className="space-y-2 text-zinc-300 text-sm">
              <li>• Go to AWS EC2 Dashboard</li>
              <li>• Launch new instance: Ubuntu 22.04 LTS, <strong>ARM64</strong></li>
              <li>• Instance type: <code className="bg-zinc-900 px-2 py-1 rounded">t4g.small</code> (2 GB RAM, ARM — cheaper than the x86 equivalent)</li>
              <li>• Storage: 20GB+ (for Docker images and database)</li>
              <li>• Security Group: 80 (HTTP), 443 (HTTPS), and 22 (SSH) <strong>restricted to your own IP</strong></li>
              <li>• Do <strong>not</strong> open port 3005 or 20129 — see below</li>
            </ul>
          </div>

          {/* Step 2: Install Docker */}
          <div className="pl-6 border-l-2 border-purple-500">
            <h5 className="text-lg font-semibold text-purple-400 mb-2">
              Step 2: Install Docker
            </h5>
            <div className="bg-zinc-900 rounded-lg p-4 font-mono text-sm text-zinc-300">
              <div>curl -fsSL https://get.docker.com | sudo sh</div>
              <div className="mt-2">sudo usermod -aG docker ubuntu</div>
              <div className="mt-2">sudo systemctl enable docker</div>
            </div>
          </div>

          {/* Step 3: Copy Files */}
          <div className="pl-6 border-l-2 border-green-500">
            <h5 className="text-lg font-semibold text-green-400 mb-2">
              Step 3: Upload Your Project Files
            </h5>
            <ul className="space-y-2 text-zinc-300 text-sm mb-3">
              <li>• Use SCP, SFTP, or Git to upload your project</li>
              <li>• Essential files (you already have these!):</li>
            </ul>
            <div className="bg-zinc-900 rounded-lg p-4 space-y-1 text-sm">
              <div className="text-green-400">✅ Dockerfile</div>
              <div className="text-green-400">✅ docker-compose.yml</div>
              <div className="text-green-400">✅ .env.production.example</div>
              <div className="text-zinc-500">→ Copy to <code className="text-zinc-400">.env.production</code> and fill in</div>
            </div>
          </div>

          {/* Step 4: Configure Environment */}
          <div className="pl-6 border-l-2 border-orange-500">
            <h5 className="text-lg font-semibold text-orange-400 mb-2">
              Step 4: Configure .env.production
            </h5>
            <div className="bg-zinc-900 rounded-lg p-4 font-mono text-sm text-zinc-300 space-y-1">
              <div><span className="text-purple-400">AUTH_SECRET</span>=<span className="text-green-400">&lt;generate with: openssl rand -hex 32&gt;</span></div>
              <div><span className="text-purple-400">ADMIN_EMAILS</span>=<span className="text-green-400">your@email.com</span></div>
              <div><span className="text-purple-400">RESEND_API_KEY</span>=<span className="text-green-400">&lt;free from resend.com&gt;</span></div>
              <div><span className="text-purple-400">OMNIROUTE_TRUST_PROXY</span>=<span className="text-green-400">true</span></div>
              <div><span className="text-purple-400">AUTH_DEV_SHOW_OTP</span>=<span className="text-green-400">false</span></div>
              <div><span className="text-purple-400">UPI_AUTO_APPROVE</span>=<span className="text-green-400">false</span></div>
              <div><span className="text-purple-400">OMNIROUTE_ENABLE_FILE_TOOLS</span>=<span className="text-green-400">false</span></div>
            </div>
            <p className="text-zinc-400 text-sm mt-3">
              <strong className="text-orange-400">
                One optional setting, only if you are self-hosting on the same
                machine or LAN as your gateway:
              </strong>{" "}
              <code className="bg-zinc-900 px-1 rounded">OMNIROUTE_ALLOW_PRIVATE_GATEWAY=true</code>.
              A production build refuses to fetch loopback and private addresses,
              which is what stops a hostile base URL from turning this server
              into a probe of its own network — including the cloud metadata
              endpoint that hands out instance credentials. Setting it to true
              removes that protection for every provider URL any user saves, so
              set it only on a box you control and never on a deployment other
              people can sign up to. If your gateway is on a different machine
              from the app, use a tunnel instead and leave this alone.
            </p>
            <p className="text-zinc-400 text-sm mt-3">
              <strong className="text-orange-400">
                Running it with Docker on your own machine? The flag alone is not
                enough.
              </strong>{" "}
              Inside a container,{" "}
              <code className="bg-zinc-900 px-1 rounded">localhost</code> means
              the container — so a gateway on your laptop is not at{" "}
              <code className="bg-zinc-900 px-1 rounded">
                localhost:20128
              </code>{" "}
              from in there, even though the app is published on your loopback
              and looks local in the browser. The base URL has to become{" "}
              <code className="bg-zinc-900 px-1 rounded">
                http://host.docker.internal:20128/v1
              </code>
              , and because that name also resolves to a private address you
              need the flag above as well. The gateway wizard detects this case
              and fills in the right address for you;{" "}
              <code className="bg-zinc-900 px-1 rounded">docker-compose.yml</code>{" "}
              already carries the{" "}
              <code className="bg-zinc-900 px-1 rounded">extra_hosts</code> entry
              that makes the name resolve on a Linux host.
            </p>
            <p className="text-zinc-400 text-sm mt-3">
              <strong>Important:</strong> users add their own provider API keys
              through Settings after signing up — you do not need a gateway key
              here.
            </p>
            <p className="text-zinc-400 text-sm mt-2">
              The last three are not advisory. A production boot <strong>aborts</strong>{" "}
              if any of them is true, as it does on a missing or hand-typed{" "}
              <code className="bg-zinc-900 px-1 rounded">AUTH_SECRET</code>. If
              the container exits straight after{" "}
              <code className="bg-zinc-900 px-1 rounded">docker compose up</code>,
              the log names the setting it objected to.
            </p>
          </div>

          {/* Step 5: Launch */}
          <div className="pl-6 border-l-2 border-cyan-500">
            <h5 className="text-lg font-semibold text-cyan-400 mb-2">
              Step 5: Launch Application
            </h5>
            <div className="bg-zinc-900 rounded-lg p-4 font-mono text-sm text-zinc-300">
              <div>cd /path/to/omniroute-coder</div>
              <div className="mt-2">docker compose up -d --build</div>
            </div>
            <p className="text-zinc-400 text-sm mt-3">
              The container publishes to{" "}
              <code className="bg-zinc-900 px-2 py-1 rounded">127.0.0.1:3005</code>{" "}
              only, so <strong>http://your-ec2-ip will not load</strong> — and
              that is deliberate. Plain HTTP would break sign-in anyway: the
              session cookie is issued <code className="bg-zinc-900 px-1 rounded">secure</code>{" "}
              in production, so the browser never sends it back. Finish Step 6
              and use the HTTPS URL.
            </p>
            <p className="text-zinc-400 text-sm mt-2">
              To check the app itself before TLS is ready, run{" "}
              <code className="bg-zinc-900 px-2 py-1 rounded">curl http://localhost:3005/api/health</code>{" "}
              on the instance.
            </p>
          </div>

          {/* Step 6: Setup HTTPS */}
          <div className="pl-6 border-l-2 border-pink-500">
            <h5 className="text-lg font-semibold text-pink-400 mb-2">
              Step 6: Setup HTTPS (Required!)
            </h5>
            <ul className="space-y-2 text-zinc-300 text-sm">
              <li>• Get free domain from <a href="https://www.duckdns.org" target="_blank" rel="noopener" className="text-blue-400 hover:underline">DuckDNS</a></li>
              <li>• Point the domain at your Elastic IP <strong>before</strong> installing Caddy, so the first certificate request succeeds</li>
              <li>• Install Caddy on the host for automatic SSL certificates</li>
              <li>• Caddyfile: <code className="bg-zinc-900 px-2 py-1 rounded">yourdomain.duckdns.org &#123; reverse_proxy 127.0.0.1:3005 &#125;</code></li>
              <li>• Your app will be accessible at: <code className="bg-zinc-900 px-2 py-1 rounded text-green-400">https://yourdomain.duckdns.org</code></li>
            </ul>
            <p className="text-zinc-400 text-sm mt-3">
              Caddy runs on the host, so <code className="bg-zinc-900 px-1 rounded">127.0.0.1</code>{" "}
              is exactly where it should look. Advice telling you to publish
              port 3005 &quot;so the proxy can reach it&quot; is written for a
              different layout and undoes Step 1.
            </p>
          </div>
        </div>
      </motion.div>

      {/* How Users Access */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.6 }}
        className="bg-gradient-to-r from-blue-500/10 to-purple-500/10 border border-blue-500/30 rounded-xl p-6"
      >
        <h4 className="text-xl font-semibold text-blue-400 mb-4">
          👥 How Beta Testers Access Your App
        </h4>
        <div className="space-y-3 text-zinc-300">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0 text-blue-400 font-bold">
              1
            </div>
            <div>
              <p className="font-medium">Visit Your URL</p>
              <p className="text-sm text-zinc-400">Share: <code className="bg-zinc-900 px-2 py-1 rounded">https://yourdomain.duckdns.org</code></p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0 text-blue-400 font-bold">
              2
            </div>
            <div>
              <p className="font-medium">Sign Up with Email</p>
              <p className="text-sm text-zinc-400">They receive an OTP code to verify</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0 text-blue-400 font-bold">
              3
            </div>
            <div>
              <p className="font-medium">Add Provider API Keys</p>
              <p className="text-sm text-zinc-400">Settings → Set up gateway for their own OmniRoute gateway, or Add Provider for any hosted key</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0 text-blue-400 font-bold">
              4
            </div>
            <div>
              <p className="font-medium">Start Chatting!</p>
              <p className="text-sm text-zinc-400">Full AI development experience in their browser</p>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Key Points */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.7 }}
        className="bg-gradient-to-r from-amber-500/10 to-orange-500/10 border border-amber-500/30 rounded-xl p-6"
      >
        <h4 className="text-xl font-semibold text-amber-400 mb-4">
          🔑 Key Points for Beta Testing
        </h4>
        <ul className="space-y-2 text-zinc-300">
          <li className="flex items-start gap-2">
            <span className="text-amber-400 font-bold">•</span>
            <span><strong>The .bat file is only for your local development</strong> - it's replaced by Docker in production</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-amber-400 font-bold">•</span>
            <span><strong>No "omniroute backend" needed in cloud</strong> - users connect to their external providers directly</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-amber-400 font-bold">•</span>
            <span><strong>Each user brings their own API keys</strong> - no shared API costs for you!</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-amber-400 font-bold">•</span>
            <span><strong>VS Code extension is optional</strong> - most beta testers won't need it</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-amber-400 font-bold">•</span>
            <span><strong>Full DEPLOYMENT.md exists in your project</strong> - check it for detailed production setup</span>
          </li>
        </ul>
      </motion.div>
    </div>
  );
}

function ProvidersSection({
  expandedProviders,
  toggleProvider,
  copyToClipboard,
  copiedApiKey,
}: {
  expandedProviders: string[];
  toggleProvider: (provider: string) => void;
  copyToClipboard: (text: string, id: string) => void;
  copiedApiKey: string | null;
}) {
  const providers = [
    {
      id: "omniroute-gateway",
      name: "OmniRoute Gateway (runs on your own computer)",
      icon: Globe,
      description:
        "Install it with npm, sign in at localhost:20128 with CHANGEME, combine your provider accounts into one key",
      baseUrl: "http://localhost:20128/v1",
      color: "from-blue-500 to-cyan-500",
      steps: [
        "⚡ FASTEST PATH — let the app do this for you:",
        "   → Settings → Set up gateway (or click 'Set up my gateway' on the",
        "     composer when no providers are connected yet)",
        "   → The wizard walks through every step below, copies the commands for",
        "     you, works out whether you need a tunnel, and ends with a",
        "     Test Connection so you know it works before you save.",
        "   → The rest of this section is the same thing done by hand.",
        "",
        "📦 Step 1 — Install the gateway (one time):",
        "   → Open a terminal (Command Prompt, PowerShell or Terminal)",
        "   → npm install -g omniroute",
        "   → Needs Node.js. If 'npm' is not recognised, install Node first.",
        "",
        "▶️ Step 2 — Start it:",
        "   → omniroute",
        "   → Leave that terminal window open. Closing it stops the gateway, and",
        "     the models disappear from this app until you start it again.",
        "",
        "🔐 Step 3 — Sign in to the gateway dashboard:",
        "   → Open http://localhost:20128/dashboard in your browser",
        "   → Default password: CHANGEME",
        "     (or whatever you set INITIAL_PASSWORD to before first launch)",
        "   → This password belongs to the GATEWAY, not to OmniRoute Coder.",
        "     They are separate accounts and separate passwords.",
        "   → Change it from the default before exposing the gateway to anything",
        "     beyond your own machine.",
        "",
        "🔗 Step 4 — Add your provider accounts in that dashboard:",
        "   → Add each provider you have access to (Antigravity, Kiro, and so on)",
        "   → Give each one a name you will recognise, e.g. 'Antigravity-Main'",
        "",
        "🎛️ Step 5 — Create a combo (optional but recommended):",
        "   → Combos section → Create New Combo",
        "   → Pick the accounts to include and set the fallback order",
        "   → A combo is one model id that routes to whichever account is healthy",
        "",
        "🔑 Step 6 — Generate an API key:",
        "   → API Keys section → Generate New Key",
        "   → Point it at your combo (or at a single account)",
        "   → Copy it now — the dashboard will not show it again",
        "",
        "🏠 Step 7a — If OmniRoute Coder runs on the SAME machine as the gateway:",
        "   → Base URL is http://localhost:20128/v1 (copy it from above)",
        "   → That is all. Go to Step 8.",
        "",
        "📦 Step 7a-bis — Same machine, but the app is running in Docker:",
        "   → Use http://host.docker.internal:20128/v1 instead.",
        "   → Inside a container 'localhost' means the container, so port 20128",
        "     looks empty from in there even with the gateway running beside it.",
        "   → That name resolves to a private address, so you also need",
        "     OMNIROUTE_ALLOW_PRIVATE_GATEWAY=true and a restart.",
        "   → The setup wizard spots this and fills the address in for you.",
        "",
        "🌍 Step 7b — If OmniRoute Coder is DEPLOYED somewhere (a server, AWS, a",
        "   shared link) while the gateway runs on your PC:",
        "   → 'localhost' will NOT work, and this is not a bug you can configure",
        "     away. The request to your gateway is made by the SERVER, so",
        "     'localhost' means the server's own machine — not yours. The server",
        "     has no route to your PC at all.",
        "     Symptoms: 'No Providers Connected' and 'Could not load model list'.",
        "   → Give the gateway a public address with a tunnel:",
        "     cloudflared tunnel --url http://localhost:20128",
        "   → It prints an https://….trycloudflare.com address. Use that address",
        "     with /v1 on the end as your Base URL.",
        "   → Keep both the gateway and the tunnel running. Your PC has to stay",
        "     awake for either to answer.",
        "   → A free trycloudflare address changes every time you restart the",
        "     tunnel, so you will need to update the Base URL when it does.",
        "",
        "⚙️ Step 8 — Enter it in OmniRoute Coder:",
        "   → Settings → External Providers → Add Provider",
        "   → Provider type: OmniRoute Gateway",
        "   → Base URL: the address from Step 7a or 7b",
        "   → API Key: the key from Step 6",
        "   → Click 'Test Connection'. It should report how many models it found.",
        "   → Save. The model picker fills in on its own.",
      ],
      additionalInfo: {
        title: "💡 Why route through a gateway at all",
        items: [
          "Automatic failover: if one account is rate-limited or down, requests move to the next",
          "One key in this app instead of a separate key per provider",
          "Combos give you a single model id that picks the account for you",
          "Your provider keys stay in the gateway on your machine, not in this app",
          "Swap or add providers in the gateway without touching OmniRoute Coder",
        ],
      },
    },
    {
      id: "agentrouter",
      name: "AgentRouter",
      icon: Zap,
      description: "Multi-model AI gateway with automatic routing and failover",
      signupUrl: "https://agentrouter.org/register?aff=93bZ",
      color: "from-purple-500 to-pink-500",
      steps: [
        "Click the signup link above and create an account",
        "Navigate to the API Keys section in your dashboard",
        "Generate a new API key for OmniRoute Coder",
        "Copy the key and paste it in Settings → External Providers → AgentRouter",
        "Select your preferred models from the available options",
      ],
    },
    {
      id: "apinex",
      name: "APINeX",
      icon: ArrowRight,
      description: "Premium API aggregation service with competitive pricing",
      signupUrl: "https://apinex.bond/overview",
      referralCode: "8N7BA6PK",
      color: "from-green-500 to-emerald-500",
      steps: [
        "Visit the APINeX overview page and sign up",
        "Use referral code: 8N7BA6PK during registration",
        "Go to your account settings and generate an API key",
        "In OmniRoute Coder, open Settings → External Providers",
        "Paste your APINeX key in the appropriate field",
      ],
    },
    {
      id: "google-ai-studio",
      name: "Google AI Studio (Gemini)",
      icon: Sparkles,
      description: "Gemini models on a free key — the fastest way to get something working",
      signupUrl: "https://aistudio.google.com/apikey",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      color: "from-sky-500 to-indigo-500",
      steps: [
        "🔑 Get the key:",
        "   → Open aistudio.google.com/apikey and sign in with any Google account",
        "   → Click 'Create API key' and let it pick or create a Cloud project",
        "   → Copy the key. It starts with 'AIza'. No card, no billing setup",
        "",
        "⚙️ Add it in OmniRoute Coder:",
        "   → Settings → External Providers → Google (Gemini)",
        "   → Paste the key into 'API Key'",
        "   → Paste the Base URL above, exactly as shown",
        "   → Click 'Test Connection', then pick a model from the list it loads",
        "",
        "⚠️ The Base URL is the part people get wrong:",
        "   → https://generativelanguage.googleapis.com on its own will NOT work",
        "   → The '/v1beta/openai' suffix is Google's OpenAI-compatibility layer.",
        "     Drop it and you are talking to the native Gemini API instead, which",
        "     takes a completely different request shape, so every call fails",
        "   → Symptom: 'Could not load model list', or a 404 on your first message",
      ],
      additionalInfo: {
        title: "💡 Picking a model",
        items: [
          "Test Connection fetches the live list from Google — trust the dropdown, not a name written in a guide, because these get renamed often",
          "gemini-2.0-flash is a solid default for Chat and Cowork: fast and cheap",
          "Use the strongest model you can see for Deep Cowork planning; the cost difference is small because planning is short",
          "The free tier limits requests per minute and per day rather than capping spend, so a long Deep Cowork run can hit a rate limit mid-way",
        ],
      },
    },
    {
      id: "openai-direct",
      name: "OpenAI",
      icon: Brain,
      description: "GPT models straight from OpenAI, billed to your own account",
      signupUrl: "https://platform.openai.com/api-keys",
      baseUrl: "https://api.openai.com/v1",
      color: "from-teal-500 to-green-500",
      steps: [
        "Create a key at platform.openai.com/api-keys — it starts with 'sk-'",
        "Add a payment method under Billing. Keys work but every call returns a quota error until you do, which reads like a broken key",
        "In OmniRoute Coder: Settings → External Providers → OpenAI",
        "Paste the key, paste the Base URL above, and click Test Connection",
        "Set a monthly usage limit in the OpenAI dashboard before you start a long Deep Cowork run",
      ],
    },
    {
      id: "openrouter-direct",
      name: "OpenRouter",
      icon: Layers,
      description: "One key for models from most major labs, pay-as-you-go",
      signupUrl: "https://openrouter.ai/keys",
      baseUrl: "https://openrouter.ai/api/v1",
      color: "from-fuchsia-500 to-purple-500",
      steps: [
        "Sign up at openrouter.ai and create a key under Keys — it starts with 'sk-or-'",
        "Add credit. OpenRouter is prepaid, so there is no surprise bill",
        "In OmniRoute Coder: Settings → External Providers → OpenRouter",
        "Paste the key and the Base URL above, then Test Connection",
        "Model ids here are namespaced with a slash — anthropic/claude-3.5-sonnet, meta-llama/llama-3.3-70b-instruct. Copy them from the dropdown rather than typing them",
      ],
    },
    {
      id: "groq-direct",
      name: "Groq",
      icon: Rocket,
      description: "Open models served very fast, with a usable free tier",
      signupUrl: "https://console.groq.com/keys",
      baseUrl: "https://api.groq.com/openai/v1",
      color: "from-amber-500 to-orange-500",
      steps: [
        "Create a key at console.groq.com/keys — it starts with 'gsk_'",
        "In OmniRoute Coder: Settings → External Providers → Groq",
        "Paste the key and the Base URL above, then Test Connection",
        "Note the '/openai/v1' path. A bare api.groq.com will not work — same trap as Google, for the same reason",
        "Good when you want quick iteration; the trade-off is that the strongest closed models are not available here",
      ],
    },
    {
      id: "deepseek-direct",
      name: "DeepSeek",
      icon: Code2,
      description: "Strong coding models at low cost",
      signupUrl: "https://platform.deepseek.com/api_keys",
      baseUrl: "https://api.deepseek.com/v1",
      color: "from-blue-600 to-indigo-600",
      steps: [
        "Create a key at platform.deepseek.com/api_keys",
        "Top up a small amount of credit — it is prepaid",
        "In OmniRoute Coder: Settings → External Providers → DeepSeek",
        "Paste the key and the Base URL above, then Test Connection",
        "deepseek-chat is the general model; the reasoning model is slower but noticeably better at planning a multi-file change",
      ],
    },
    {
      id: "local",
      name: "Local Models (LM Studio / Ollama)",
      icon: Cpu,
      description: "Run AI models locally on your machine for privacy and offline use",
      color: "from-orange-500 to-red-500",
      steps: [
        "Download and install LM Studio or Ollama",
        "Load your preferred model (e.g., Llama 3, Mistral, CodeLlama)",
        "Start the local server (usually on http://localhost:1234 or :11434)",
        "In OmniRoute Coder Settings, go to Local Models section",
        "Enter the server URL and select the running model",
        "Test the connection to ensure it's working",
      ],
      additionalInfo: {
        title: "Recommended Local Models",
        items: [
          "CodeLlama 13B - Great for code assistance",
          "Mistral 7B - Fast and efficient",
          "Llama 3 8B - Good general purpose model",
          "DeepSeek Coder - Optimized for coding tasks",
        ],
      },
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-2xl font-bold text-white mb-2">
          Connect AI Providers
        </h3>
        <p className="text-zinc-400 mb-4">
          OmniRoute Coder supports multiple AI providers. Choose external
          services for cutting-edge models or run local models for privacy.
        </p>
        <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4 space-y-2">
          <p className="text-sm text-zinc-300">
            <strong className="text-blue-400">Start here:</strong> if you plan to
            use the OmniRoute gateway, open{" "}
            <strong>Settings → Set up gateway</strong>. The wizard hands you each
            command to copy, gets you into the gateway&apos;s dashboard, works
            out whether you need a tunnel, and tests the connection before it
            saves anything. It does not run anything on your machine — you paste
            the commands into your own terminal. Everything in the OmniRoute
            Gateway card below is the same process done by hand.
          </p>
          <p className="text-sm text-zinc-300">
            {/* This used to say "no additional software needed on your
                computer" — true for hosted providers like OpenAI or Groq, and
                flatly wrong for the gateway, which is a program you install and
                keep running. Someone reading the old line had no reason to
                expect an npm install, so the gateway looked broken rather than
                absent. */}
            <strong className="text-blue-400">Two kinds of provider:</strong>{" "}
            hosted services (OpenAI, Groq, OpenRouter, Google and the rest) need
            nothing but an API key pasted into this app. The OmniRoute gateway
            and local model servers (Ollama, LM Studio, llama.cpp) are software
            that runs on your own machine and has to be running for its models to
            appear here.
          </p>
          <p className="text-sm text-zinc-300">
            <strong className="text-blue-400">More than what is listed here:</strong>{" "}
            Settings → External Providers has a dropdown that pre-fills the correct
            Base URL and auth header for every provider it knows about, including
            Azure OpenAI, Anthropic via a proxy, vLLM, llama.cpp and a free-form
            Custom option. Pick from that list before typing a URL by hand — it is
            filled in from the same source this guide is.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {providers.map((provider, idx) => {
          const Icon = provider.icon;
          const isExpanded = expandedProviders.includes(provider.id);

          return (
            <motion.div
              key={provider.id}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: idx * 0.1 }}
              className="border border-zinc-700 rounded-xl overflow-hidden bg-zinc-800/30"
            >
              <button
                onClick={() => toggleProvider(provider.id)}
                className="w-full p-5 flex items-center justify-between hover:bg-zinc-800/50 transition-colors"
              >
                <div className="flex items-center gap-4">
                  <div
                    className={`w-12 h-12 rounded-lg bg-gradient-to-br ${provider.color} flex items-center justify-center`}
                  >
                    <Icon className="w-6 h-6 text-white" />
                  </div>
                  <div className="text-left">
                    <h4 className="text-lg font-semibold text-white">
                      {provider.name}
                    </h4>
                    <p className="text-sm text-zinc-400">
                      {provider.description}
                    </p>
                  </div>
                </div>
                <motion.div
                  animate={{ rotate: isExpanded ? 90 : 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <ChevronRight className="w-5 h-5 text-zinc-400" />
                </motion.div>
              </button>

              <AnimatePresence>
                {isExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.3 }}
                    className="border-t border-zinc-700"
                  >
                    <div className="p-6 space-y-4 bg-zinc-900/50">
                      {provider.signupUrl && (
                        <a
                          href={provider.signupUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 text-blue-400 hover:text-blue-300 transition-colors"
                        >
                          <ExternalLink className="w-4 h-4" />
                          <span className="font-medium">
                            Sign up for {provider.name}
                          </span>
                        </a>
                      )}

                      {provider.baseUrl && (
                        <div className="bg-zinc-800 rounded-lg p-3 border border-zinc-700">
                          <div className="flex items-center gap-2 mb-2">
                            <Link className="w-4 h-4 text-cyan-400" />
                            <span className="text-xs font-semibold uppercase tracking-wide text-cyan-400">
                              Base URL — paste this exactly
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <code className="flex-1 font-mono text-sm text-zinc-200 break-all">
                              {provider.baseUrl}
                            </code>
                            <button
                              onClick={() =>
                                copyToClipboard(
                                  provider.baseUrl!,
                                  `${provider.id}-url`
                                )
                              }
                              className="flex-shrink-0 p-1.5 hover:bg-zinc-700 rounded transition-colors"
                              aria-label="Copy base URL"
                            >
                              {copiedApiKey === `${provider.id}-url` ? (
                                <CheckCircle className="w-4 h-4 text-green-400" />
                              ) : (
                                <Copy className="w-4 h-4 text-zinc-400" />
                              )}
                            </button>
                          </div>
                          <p className="text-xs text-zinc-500 mt-2">
                            The path after the hostname is part of the address, not
                            decoration. Trimming it is the single most common reason a
                            key that works elsewhere fails here.
                          </p>
                        </div>
                      )}

                      {provider.referralCode && (
                        <div className="flex items-center gap-3 bg-zinc-800 rounded-lg p-3">
                          <Key className="w-4 h-4 text-purple-400" />
                          <span className="text-sm text-zinc-300">
                            Referral Code:{" "}
                            <code className="font-mono text-purple-400">
                              {provider.referralCode}
                            </code>
                          </span>
                          <button
                            onClick={() =>
                              copyToClipboard(
                                provider.referralCode!,
                                provider.id
                              )
                            }
                            className="ml-auto p-1 hover:bg-zinc-700 rounded transition-colors"
                          >
                            {copiedApiKey === provider.id ? (
                              <CheckCircle className="w-4 h-4 text-green-400" />
                            ) : (
                              <Copy className="w-4 h-4 text-zinc-400" />
                            )}
                          </button>
                        </div>
                      )}

                      <div>
                        <h5 className="font-semibold text-white mb-3 flex items-center gap-2">
                          <CheckCircle className="w-4 h-4 text-green-400" />
                          Setup Steps:
                        </h5>
                        <ol className="space-y-2">
                          {provider.steps.map((step, stepIdx) => (
                            <motion.li
                              key={stepIdx}
                              initial={{ opacity: 0, x: -10 }}
                              animate={{ opacity: 1, x: 0 }}
                              transition={{ delay: stepIdx * 0.05 }}
                              className="flex gap-3 text-zinc-300"
                            >
                              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-600/20 text-blue-400 flex items-center justify-center text-sm font-semibold">
                                {stepIdx + 1}
                              </span>
                              <span className="text-sm">{step}</span>
                            </motion.li>
                          ))}
                        </ol>
                      </div>

                      {provider.additionalInfo && (
                        <div className="bg-zinc-800 rounded-lg p-4 border border-zinc-700">
                          <h6 className="font-semibold text-white mb-2">
                            {provider.additionalInfo.title}
                          </h6>
                          <ul className="space-y-1">
                            {provider.additionalInfo.items.map((item, idx) => (
                              <li
                                key={idx}
                                className="text-sm text-zinc-300 flex items-center gap-2"
                              >
                                <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                                {item}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          );
        })}
      </div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-5"
      >
        <div className="flex items-start gap-3">
          <Sparkles className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
          <div>
            <h5 className="font-semibold text-blue-400 mb-1">Pro Tip</h5>
            <p className="text-sm text-zinc-300">
              You can configure multiple providers and switch between them on
              the fly. Each provider offers different models with varying
              capabilities and pricing.
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function ModesSection() {
  const modes = [
    {
      name: "Chat Mode",
      icon: MessageSquare,
      color: "from-blue-500 to-cyan-500",
      description: "Standard conversational AI assistance",
      features: [
        "Quick Q&A and code help",
        "Syntax explanations",
        "Algorithm suggestions",
        "General programming advice",
      ],
      bestFor: "Quick questions, learning, brainstorming",
      workflow: [
        { step: "Type your question", icon: MessageSquare },
        { step: "AI responds instantly", icon: Brain },
        { step: "Iterate and refine", icon: RefreshCw },
      ],
    },
    {
      name: "Cowork Mode",
      icon: Users,
      color: "from-green-500 to-emerald-500",
      description: "Collaborative coding with file awareness",
      features: [
        "Access to workspace files",
        "Multi-file context understanding",
        "Code suggestions in context",
        "Basic file operations",
      ],
      bestFor: "Working on small features, refactoring, debugging",
      workflow: [
        { step: "Select workspace", icon: Folder },
        { step: "AI reads relevant files", icon: FileCode },
        { step: "Collaborative editing", icon: Users },
      ],
    },
    {
      name: "Deep Cowork Mode",
      icon: Layers,
      color: "from-purple-500 to-pink-500",
      description: "Advanced agentic workflow with planning and execution",
      features: [
        "Multi-step task planning",
        "Autonomous file editing",
        "Tool usage (search, terminal, etc.)",
        "Plan approval before execution",
        "Iterative problem-solving",
      ],
      bestFor: "Complex features, architecture changes, large refactors",
      workflow: [
        { step: "Describe complex task", icon: FileText },
        { step: "AI creates a plan", icon: Brain },
        { step: "You approve plan", icon: CheckCircle },
        { step: "AI executes autonomously", icon: Zap },
        { step: "Review changes", icon: Code2 },
      ],
    },
    {
      name: "Ultra Mode",
      icon: Zap,
      color: "from-orange-500 to-red-500",
      description: "Maximum context and capabilities",
      features: [
        "Largest context window",
        "Most powerful models",
        "Advanced reasoning",
        "Complex problem-solving",
      ],
      bestFor: "Very complex tasks requiring deep understanding",
      workflow: [
        { step: "Present complex challenge", icon: Brain },
        { step: "AI analyzes deeply", icon: Layers },
        { step: "Comprehensive solution", icon: Sparkles },
      ],
    },
    {
      name: "Production Mode",
      icon: Rocket,
      color: "from-red-500 to-pink-500",
      description: "⚠️ Work in Progress",
      features: [
        "WebContainer sandbox environment",
        "Full development lifecycle",
        "Enterprise-grade security",
        "Coming soon...",
      ],
      bestFor: "Full-stack development (under development)",
      workflow: [
        { step: "🚧 Not yet available", icon: AlertTriangle },
      ],
      isWIP: true,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-2xl font-bold text-white mb-2">Working Modes</h3>
        <p className="text-zinc-400">
          Choose the right mode for your task. Each mode offers different
          capabilities and levels of autonomy.
        </p>
      </div>

      <div className="space-y-6">
        {modes.map((mode, idx) => {
          const Icon = mode.icon;
          return (
            <motion.div
              key={mode.name}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.1 }}
              className={`border rounded-xl overflow-hidden ${
                mode.isWIP
                  ? "border-red-500/30 bg-red-500/5"
                  : "border-zinc-700 bg-zinc-800/30"
              }`}
            >
              <div className="p-6">
                <div className="flex items-start gap-4 mb-4">
                  <div
                    className={`w-14 h-14 rounded-xl bg-gradient-to-br ${mode.color} flex items-center justify-center flex-shrink-0`}
                  >
                    <Icon className="w-7 h-7 text-white" />
                  </div>
                  <div className="flex-1">
                    <h4 className="text-xl font-bold text-white mb-1 flex items-center gap-2">
                      {mode.name}
                      {mode.isWIP && (
                        <span className="text-xs bg-red-500/20 text-red-400 px-2 py-1 rounded-full font-medium">
                          WIP
                        </span>
                      )}
                    </h4>
                    <p className="text-zinc-400">{mode.description}</p>
                  </div>
                </div>

                <div className="grid md:grid-cols-2 gap-6">
                  <div>
                    <h5 className="font-semibold text-white mb-3 flex items-center gap-2">
                      <CheckCircle className="w-4 h-4 text-green-400" />
                      Features
                    </h5>
                    <ul className="space-y-2">
                      {mode.features.map((feature, fidx) => (
                        <li
                          key={fidx}
                          className="flex items-start gap-2 text-sm text-zinc-300"
                        >
                          <div className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-1.5 flex-shrink-0" />
                          <span>{feature}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div>
                    <h5 className="font-semibold text-white mb-3 flex items-center gap-2">
                      <ArrowRight className="w-4 h-4 text-blue-400" />
                      Workflow
                    </h5>
                    <div className="space-y-3">
                      {mode.workflow.map((item, widx) => {
                        const WIcon = item.icon;
                        return (
                          <motion.div
                            key={widx}
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: idx * 0.1 + widx * 0.05 }}
                            className="flex items-center gap-3"
                          >
                            <div className="w-8 h-8 rounded-lg bg-zinc-700 flex items-center justify-center flex-shrink-0">
                              <WIcon className="w-4 h-4 text-zinc-300" />
                            </div>
                            <span className="text-sm text-zinc-300">
                              {item.step}
                            </span>
                          </motion.div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div className="mt-4 pt-4 border-t border-zinc-700">
                  <p className="text-sm text-zinc-400">
                    <span className="font-semibold text-white">Best for:</span>{" "}
                    {mode.bestFor}
                  </p>
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

function VSCodeSection() {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-2xl font-bold text-white mb-2">
          VS Code Extension
        </h3>
        <p className="text-zinc-400 mb-4">
          The extension is what gives Deep Cowork the ability to read and write
          files. Your code never leaves your machine and is never uploaded
          anywhere: the extension dials <em>out</em> to OmniRoute, and OmniRoute
          asks it for the one file it needs, when it needs it.
        </p>
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <CheckCircle className="w-5 h-5 text-emerald-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm text-emerald-300 font-semibold mb-1">
                Works whether OmniRoute runs on this machine or on a server
              </p>
              <p className="text-sm text-zinc-300">
                <strong>OmniRoute on your own machine:</strong> install the
                extension, click &ldquo;Open in VS Code&rdquo;, approve a folder.
                <br />
                <strong>A hosted OmniRoute (e.g. on AWS):</strong> exactly the
                same three steps. The extension opens the connection outwards,
                so nothing has to be reachable on your side — no port forwarding,
                no public IP, no firewall change. Each person&apos;s pairing code
                is tied to their own account, so the editor that answers a
                request is always the one belonging to whoever asked.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-4 bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm text-amber-300 font-semibold mb-1">
                Version 0.3.0 — reinstall if you paired before this build
              </p>
              <p className="text-sm text-zinc-300">
                From 0.3.0 the server sends your <strong>File access</strong>{" "}
                rules to the extension when it connects, and again every time
                you save them, so the editor holding your files enforces the
                same list the server does. An older build does not understand
                that message and quietly falls back to its own built-in
                defaults — your rules would still be enforced server-side, but
                the editor would not know about them. Download the current
                .vsix from &ldquo;Connect VS Code&rdquo; and install it over the
                top; your pairing and your approved folder both survive.
              </p>
            </div>
          </div>
        </div>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-gradient-to-br from-blue-600/20 to-purple-600/20 border border-blue-500/30 rounded-xl p-8"
      >
        <div className="flex items-center gap-4 mb-6">
          <div className="w-16 h-16 rounded-2xl bg-blue-600 flex items-center justify-center">
            <Code2 className="w-8 h-8 text-white" />
          </div>
          <div>
            <h4 className="text-2xl font-bold text-white">
              OmniRoute VS Code Extension
            </h4>
            <p className="text-zinc-300">Direct workspace integration</p>
          </div>
        </div>

        <div className="space-y-6">
          <div>
            <h5 className="font-semibold text-white mb-3 flex items-center gap-2">
              <Download className="w-5 h-5 text-blue-400" />
              Installation Steps
            </h5>
            <div className="space-y-6">
              {[
                {
                  title: "📦 Step 1: Download the Extension File",
                  details: [
                    "In OmniRoute, open 'Connect VS Code' (sidebar, or the pill next to the folder picker)",
                    "Step 1 of that panel has a download button — it always serves the current build, with the version, size and SHA-256 shown next to it",
                    "Save it somewhere easy to find (like your Downloads folder or Desktop)",
                    "If someone sent you the .vsix directly instead, compare its SHA-256 with the one shown in the panel before installing it",
                  ]
                },
                {
                  title: "💻 Step 2: Open VS Code",
                  details: [
                    "Open VS Code on your computer (any folder is fine, doesn't matter which project)",
                    "You can have an empty VS Code window - that's perfectly okay",
                    "The extension will work across all your projects once installed",
                  ]
                },
                {
                  title: "⌨️ Step 3: Open Command Palette",
                  details: [
                    "Windows/Linux: Press Ctrl+Shift+P",
                    "Mac: Press Cmd+Shift+P",
                    "A search box will appear at the top of VS Code",
                  ]
                },
                {
                  title: "🧹 Step 4: Remove any older OmniRoute extension first",
                  details: [
                    "In the search box type: @installed omniroute",
                    "If you see an entry published by 'undefined_publisher', that is the old v0.1.0 build — uninstall it now",
                    "This matters: the old build has a different extension id, so installing the new one leaves BOTH in place. Two copies claim the same commands and the newer one stops halfway through starting up",
                    "If you have never installed OmniRoute before, there will be nothing here — skip straight on",
                  ]
                },
                {
                  title: "🔍 Step 5: Type 'Install from VSIX'",
                  details: [
                    "Open the Command Palette again (Ctrl+Shift+P)",
                    "In the search box, type: Install from VSIX",
                    "Select 'Extensions: Install from VSIX...' from the dropdown",
                    "A file browser window will open (this is what you see in the screenshot)",
                  ]
                },
                {
                  title: "📁 Step 6: Navigate to the File",
                  details: [
                    "In the file browser, find the .vsix you saved in Step 1",
                    "Click on the file to select it (it will be highlighted)",
                    "Click the 'Install' button (bottom-right of the file browser)",
                    "VS Code will install the extension (takes 2-3 seconds)",
                  ]
                },
                {
                  title: "🔄 Step 7: Reload VS Code",
                  details: [
                    "VS Code will show a notification: 'Please reload Visual Studio Code to enable the extension'",
                    "Click 'Reload Now' in the notification",
                    "OR: Close and reopen VS Code manually",
                  ]
                },
                {
                  title: "🔗 Step 8: Pair It — One Click",
                  details: [
                    "Back in OmniRoute, in the same 'Connect VS Code' panel, click 'Create code'",
                    "Click 'Open in VS Code'. Your browser asks permission to open the editor, then VS Code asks you to confirm the connection — say yes to both",
                    "That is it: nothing to copy, nothing to paste, nothing to type",
                    "The code is stored in your OS keychain, not in settings.json, so it is never synced or committed",
                    "If nothing happened, VS Code is not registered to handle these links on your machine. Click 'Copy instead', then in VS Code press Ctrl+Shift+P and run: OmniRoute: Connect (paste pairing code)",
                  ]
                },
                {
                  title: "📂 Step 9: Approve a Folder",
                  details: [
                    "VS Code will ask which folder OmniRoute may access — nothing is readable until you say so",
                    "Approval is per folder: a folder you have not approved stays private, even with the extension running",
                    "Change your mind any time with: OmniRoute: Manage Folder Access",
                    "The status bar shows a folder icon when access is live",
                  ]
                },
                {
                  title: "✅ Step 10: Verify the Connection",
                  details: [
                    "The 'Connect VS Code' panel in OmniRoute turns green and names the approved folder",
                    "The live activity feed there shows every file read and write as it happens",
                    "Revoke access from that panel at any time — revoking also closes the live connection immediately",
                    "You're ready for Full Deep Cowork Mode!",
                  ]
                },
              ].map((step, idx) => (
                <div key={idx} className="bg-zinc-900/50 rounded-lg p-4 border border-zinc-700">
                  <div className="flex items-start gap-3 mb-3">
                    <span className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-600/20 text-blue-400 flex items-center justify-center text-sm font-bold">
                      {idx + 1}
                    </span>
                    <h5 className="font-semibold text-white pt-1">{step.title}</h5>
                  </div>
                  <ul className="ml-11 space-y-2">
                    {step.details.map((detail, detailIdx) => (
                      <li key={detailIdx} className="flex items-start gap-2 text-sm text-zinc-300">
                        <span className="text-blue-400 mt-1">•</span>
                        <span>{detail}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-zinc-900/50 rounded-xl p-5 border border-zinc-700">
            <h5 className="font-semibold text-white mb-3 flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-purple-400" />
              What You Get
            </h5>
            <div className="grid md:grid-cols-2 gap-3">
              {[
                "Real-time file synchronization",
                "Direct file editing from AI",
                "Workspace selection from VS Code",
                "Automatic diff previews",
                "WebSocket-based live updates",
                "No manual file copying needed",
              ].map((feature, idx) => (
                <div key={idx} className="flex items-center gap-2 text-sm text-zinc-300">
                  <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                  <span>{feature}</span>
                </div>
              ))}
            </div>
          </div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
              <div>
                <h6 className="font-semibold text-amber-400 mb-1">
                  Connection Setup
                </h6>
                <p className="text-sm text-zinc-300">
                  The extension dials <em>out</em> to wherever OmniRoute is
                  running, so it works both ways round. On a hosted deployment
                  that is{" "}
                  <code className="px-1 rounded bg-zinc-900">wss://your-host/vscode-bridge</code>{" "}
                  and you pair it from the web app. Running
                  OmniRoute on this same machine, it is{" "}
                  <code className="px-1 rounded bg-zinc-900">ws://127.0.0.1:20129</code>{" "}
                  (override the port with{" "}
                  <code className="px-1 rounded bg-zinc-900">OMNIROUTE_BRIDGE_PORT</code>).
                  Either way that is the bridge port, not the port you open the
                  web UI on — and the app hands you the right address when you
                  generate the token, so you should not have to type either.
                </p>
              </div>
            </div>
          </motion.div>
        </div>
      </motion.div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-5">
          <h5 className="font-semibold text-white mb-3">❌ Without Extension</h5>
          <p className="text-xs text-zinc-400 mb-3">Limited functionality</p>
          <ul className="space-y-2 text-sm text-zinc-300">
            <li className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-green-400" />
              Chat with AI in browser
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-green-400" />
              Get code suggestions
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-green-400" />
              View Deep Cowork planning
            </li>
            <li className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-400" />
              AI CANNOT edit files on your PC
            </li>
            <li className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-400" />
              Manual copy/paste required
            </li>
          </ul>
        </div>
        <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-5">
          <h5 className="font-semibold text-white mb-3">✅ With Extension (FULL FEATURES)</h5>
          <p className="text-xs text-zinc-400 mb-3">Complete Deep Cowork Mode</p>
          <ul className="space-y-2 text-sm text-zinc-300">
            <li className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-green-400" />
              AI can READ files on your PC
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-green-400" />
              AI can WRITE/EDIT files directly
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-green-400" />
              Real-time workspace sync
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-green-400" />
              Full Deep Cowork Mode enabled
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-green-400" />
              WebSocket bridge for file ops
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function FeaturesSection() {
  const features = [
    {
      title: "Slash Commands",
      icon: Terminal,
      description: "Quick actions with / prefix",
      items: [
        "/clear - Clear chat history",
        "/export - Export conversation",
        "/settings - Open settings",
        "/workspace - Select workspace",
      ],
    },
    {
      title: "File Attachments",
      icon: FileCode,
      description: "Attach files for context",
      items: [
        "Drag & drop files",
        "Code files for analysis",
        "PDFs for document understanding",
        "Multiple attachments supported",
      ],
    },
    {
      title: "Document Export",
      icon: FileText,
      description: "Export conversations",
      items: [
        "Markdown format",
        "PDF with syntax highlighting",
        "DOCX for Word compatibility",
        "Preserve code formatting",
      ],
    },
    {
      title: "Workspace Management",
      icon: Folder,
      description: "Flexible project handling",
      items: [
        "Multiple workspace support",
        "Quick workspace switching",
        "Recent workspace history",
        "VS Code integration",
      ],
    },
    {
      title: "Token Management",
      icon: Coins,
      description: "Track AI usage",
      items: [
        "Real-time token counting",
        "Cost estimation per message",
        "Provider-specific tracking",
        "Usage history",
      ],
    },
    {
      title: "File Access Control",
      icon: Lock,
      description: "Sidebar → File access",
      items: [
        "Credentials (.env, keys) always refuse to open",
        "Switch off whole groups: deps, build output, lockfiles",
        "Add your own .gitignore-style rules",
        "Check any path before you save the rule",
      ],
    },
    {
      title: "Security & Auth",
      icon: ShieldCheck,
      description: "Secure access control",
      items: [
        "Email OTP authentication",
        "Encrypted credential storage",
        "Per-user API keys",
        "Admin management panel",
      ],
    },
    {
      title: "Reference Project",
      icon: FolderTree,
      description: "Sidebar → Reference project",
      items: [
        "Open a second folder the assistant can read but never change",
        "Copy a feature from one project into another without pasting files",
        "Both folders go in one VS Code window (Add Folder to Workspace)",
        "Read-only and optional — toggle it off any time",
      ],
    },
    {
      title: "Skills",
      icon: Sparkles,
      description: "Reusable instructions the assistant follows",
      items: [
        "Write a playbook once instead of re-explaining it every chat",
        "Set it to apply to every message, or only when keywords appear",
        "Start from a template, or paste your own Markdown or JSON",
        "The chat shows which skills applied to each answer, and why",
      ],
    },
    {
      title: "Chat History & Storage",
      icon: Database,
      description: "How long conversations are kept",
      items: [
        "Chats and messages are stored on the server, per account",
        "A shared deployment may cap how much history one account keeps",
        "When a cap trims a chat, the transcript says so above the first message",
        "Trimming keeps the opening turns and the most recent ones",
        "On a personal instance nothing is capped and nothing is ever removed",
      ],
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-2xl font-bold text-white mb-2">
          Advanced Features
        </h3>
        <p className="text-zinc-400">
          Explore powerful features that make OmniRoute Coder a comprehensive
          development tool.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        {features.map((feature, idx) => {
          const Icon = feature.icon;
          return (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: idx * 0.05 }}
              className="bg-zinc-800/30 border border-zinc-700 rounded-xl p-5 hover:border-zinc-600 transition-all"
            >
              <div className="flex items-start gap-3 mb-4">
                <div className="w-10 h-10 rounded-lg bg-blue-600/20 flex items-center justify-center flex-shrink-0">
                  <Icon className="w-5 h-5 text-blue-400" />
                </div>
                <div>
                  <h4 className="text-lg font-semibold text-white">
                    {feature.title}
                  </h4>
                  <p className="text-sm text-zinc-400">{feature.description}</p>
                </div>
              </div>
              <ul className="space-y-2">
                {feature.items.map((item, iidx) => (
                  <li
                    key={iidx}
                    className="flex items-start gap-2 text-sm text-zinc-300"
                  >
                    <div className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-1.5 flex-shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </motion.div>
          );
        })}
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-zinc-800/30 border border-violet-500/30 rounded-xl p-6"
      >
        <h4 className="text-lg font-semibold text-white mb-2 flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-violet-400" />
          Skills, in more detail
        </h4>
        <p className="text-sm text-zinc-300 mb-4">
          A skill is a set of instructions you write once and reuse — a review
          checklist, a house writing style, the way your team names things. Open{" "}
          <span className="text-white font-medium">Skills</span> in the sidebar
          to add one.
        </p>

        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4 mb-4">
          <p className="text-sm text-emerald-200 font-medium mb-1">
            A skill is instructions, not a program.
          </p>
          <p className="text-sm text-zinc-300">
            Nothing you add here is ever executed. A skill is text that gets
            added to the assistant&apos;s instructions for a message — there is
            no script, no install step, and nothing that runs on the server. A
            file containing{" "}
            <code className="text-zinc-200 bg-zinc-900 px-1 rounded">code</code>,{" "}
            <code className="text-zinc-200 bg-zinc-900 px-1 rounded">
              entrypoint
            </code>
            , or a URL to download from is rejected with a message saying so,
            rather than quietly ignored. That is deliberate: a skill you paste
            from the internet cannot do anything your own typing could not.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <p className="text-sm text-white font-medium mb-2">
              When a skill applies
            </p>
            <ul className="space-y-1.5 text-sm text-zinc-300">
              <li className="flex items-start gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-violet-400 mt-1.5 flex-shrink-0" />
                <span>
                  <span className="text-white">Every message</span> — best for a
                  short style note that should always hold.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-violet-400 mt-1.5 flex-shrink-0" />
                <span>
                  <span className="text-white">On keywords</span> — best for a
                  long playbook that would be noise the rest of the time.
                  Keywords match whole words, so &quot;css&quot; does not fire on
                  &quot;success&quot;.
                </span>
              </li>
            </ul>
          </div>
          <div>
            <p className="text-sm text-white font-medium mb-2">
              Why a skill sometimes does not run
            </p>
            <ul className="space-y-1.5 text-sm text-zinc-300">
              <li className="flex items-start gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-1.5 flex-shrink-0" />
                <span>
                  It asks for tools that are not available right now — no editor
                  paired, or file tools switched off. It is held back rather than
                  left to describe edits it cannot make.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-1.5 flex-shrink-0" />
                <span>
                  Earlier skills used up the room allowed for skill text in one
                  message. Turn one off to make space.
                </span>
              </li>
            </ul>
            <p className="text-xs text-zinc-400 mt-2">
              Either way the chat says so under the answer, with the reason.
            </p>
          </div>
        </div>

        <p className="text-xs text-zinc-400 mt-4">
          The tools a skill lists are shown to you before you add it, and are
          checked before it runs. They do not restrict what the assistant can do
          generally — folder approval in the editor and the file-tools switch are
          what control that, and a skill cannot change either.
        </p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-gradient-to-r from-purple-500/10 to-pink-500/10 border border-purple-500/30 rounded-xl p-6"
      >
        <h4 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-purple-400" />
          Pro Tips for Maximum Productivity
        </h4>
        <div className="grid md:grid-cols-2 gap-4">
          {[
            "Use Deep Cowork mode for complex multi-file changes",
            "Attach relevant files to provide better context",
            "Export important conversations for documentation",
            "Set up multiple providers for redundancy",
            "Use slash commands for quick actions",
            "Install VS Code extension for seamless workflow",
            "If you explain the same thing twice, make it a Skill",
          ].map((tip, idx) => (
            <div key={idx} className="flex items-start gap-2 text-sm text-zinc-300">
              <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" />
              <span>{tip}</span>
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  );
}

function TroubleshootingSection() {
  const issues = [
    {
      problem: "Connection Failed / Provider Not Responding",
      solutions: [
        "Verify your API key is correct and active",
        "Check your internet connection",
        "Ensure the provider service is not down (check status pages)",
        "Try switching to a different provider temporarily",
        "Check if you have sufficient credits/balance",
      ],
    },
    {
      problem: "VS Code Extension Not Connecting",
      solutions: [
        "Have you paired it? The extension does not connect on its own. Open 'Connect VS Code' in OmniRoute, create a code, and click 'Open in VS Code'.",
        "Clicked 'Open in VS Code' and nothing happened? VS Code is not registered to handle vscode:// links on that machine — common with Flatpak and Snap installs. Use 'Copy instead', then Ctrl+Shift+P → 'OmniRoute: Connect (paste pairing code)'.",
        "Does the extension show as 'undefined_publisher' in the Extensions view? That is the old v0.1.0 build. Installing the new one does NOT replace it — the old build has a different extension id, so VS Code keeps both, and two copies fight over the same commands. The symptom is two OmniRoute items in the status bar, one spinning forever, and a click that reports \"command 'omniroute.showMenu' not found\". Uninstall the 'undefined_publisher' one, then reload the window.",
        "Tooltip says \"Nothing is listening at ws://127.0.0.1:20129\"? The address is fine and nothing is answering on it — that is the OmniRoute server not running, not a network fault. Start the app first, then click the status bar item to reconnect.",
        "Tooltip says \"The server closed the connection unexpectedly\" while OmniRoute is clearly running? Look at the pill in the OmniRoute web UI before touching anything in VS Code. A red 'Editor link off' there means the server was started without OMNIROUTE_BRIDGE_ENABLE=true, so the bridge port never opened. Under Docker that reads as a dropped connection rather than a refused one, because the published port is accepted by Docker's forwarder and then reset when nothing answers inside the container — so VS Code honestly reports a connection that was made and then lost. Set OMNIROUTE_BRIDGE_ENABLE=true in .env.production and restart the container; no change in VS Code will fix it.",
        "Red 'Editor port blocked' pill in the web UI? Different problem from 'Editor link off': the bridge is enabled but something else already owns its port, usually a second copy of the server left running from an earlier start. Stop the other one and restart, or set OMNIROUTE_BRIDGE_PORT to a free port and pair again. The server log line starting [VSCodeBridge] names the port it could not take.",
        "Seeing 'socket hang up' over and over in the Extension Host log? That is the signature of an outdated extension, not a network fault: the server now authenticates the connection and older builds cannot answer. Reinstall from the panel's download button.",
        "Was that code revoked? A revoked code closes the live connection immediately. Create a fresh one in 'Connect VS Code'.",
        "Codes expire after 30 days — the panel shows the expiry date next to each one.",
        "Reload the VS Code window (Ctrl+Shift+P → Reload Window)",
        "Running OmniRoute on this same machine? Check the bridge port (default 20129) is not taken by another process",
        "Hosted? The address must start with wss:// and end with the bridge path — the pairing code already contains it, so do not type it by hand",
      ],
    },
    {
      problem: "Files Not Being Edited",
      solutions: [
        "Have you approved a folder? Nothing is readable until you do. In VS Code: 'OmniRoute: Manage Folder Access'.",
        "Approval is per folder — opening a different project does not carry the old approval over to it.",
        "Secrets are refused on purpose: .env files, private keys, .pem/.key files and node_modules are never readable, even inside an approved folder.",
        "Check the live activity feed in 'Connect VS Code' — it names the file and the reason whenever a request is refused.",
        "Verify the correct workspace is selected",
        "Check the folder is not read-only at the OS level",
      ],
    },
    {
      problem: "High Token Usage / Unexpected Costs",
      solutions: [
        "Use Chat mode for simple queries instead of Deep Cowork",
        "Limit file attachments to only necessary context",
        "Choose smaller models for less complex tasks",
        "Monitor token usage in real-time display",
        "Set up usage alerts in your provider dashboard",
      ],
    },
    {
      problem: "Production Mode Shows 'Work in Progress'",
      solutions: [
        "This is expected - Production Mode is under development",
        "Use Deep Cowork mode for advanced agentic workflows",
        "Check back in future updates for Production Mode release",
        "Join the community for updates on feature releases",
      ],
    },
    {
      problem: "Authentication Issues / Can't Log In",
      solutions: [
        "Check your email for the code, including the spam folder",
        "On a fresh deployment sending through onboarding@resend.dev, Resend only delivers to the address that owns the Resend account — everyone else gets nothing until a domain is verified",
        "Verify a sending domain with Resend and set MAIL_FROM to an address on it",
        "Codes expire (default 10 minutes) — request a new one rather than reusing an old email",
        "Admins: the boot log prints which email provider resolved, or 'none' if nothing is configured",
        "Contact the admin if it persistently fails",
      ],
    },
    {
      problem: "'No Providers Connected' or 'Could not load model list'",
      solutions: [
        "Quickest fix: Settings → Set up gateway. The wizard checks each of the things below in order and tells you which one is failing.",
        "Read the grey line under the red one first. The model picker now says whether your BROWSER can see a gateway on this machine, which the server cannot tell you — on a deployment its 'localhost' is a datacentre. 'A gateway is answering on this machine' means the gateway is fine and only the address is wrong; 'could not find a gateway' means start it first.",
        "Open Settings → External Providers and confirm a base URL and API key are saved",
        "Is the gateway actually running? It only answers while the terminal you typed 'omniroute' in is still open. Closing that window takes every model with it.",
        "If your base URL is http://localhost:… it only works when OmniRoute runs on the same machine as the gateway. On a hosted deployment the SERVER makes that request, so localhost means the server.",
        "Running the app in Docker on your own machine: localhost inside a container is the container, so use http://host.docker.internal:20128/v1 and set OMNIROUTE_ALLOW_PRIVATE_GATEWAY=true. Setting only the flag swaps a clear refusal for a bare connection error.",
        "Self-hosted gateway + hosted app: publish the gateway with a tunnel (cloudflared tunnel --url http://localhost:20128) and use the public https URL, ending in /v1",
        "A free trycloudflare address changes every time you restart the tunnel. If it worked yesterday and not today, re-copy the new address into the Base URL.",
        "Confirm the gateway itself is running and answering — open its own dashboard in a browser",
        "Check the base URL includes the /v1 suffix if your gateway expects it",
        "Use 'Test Connection' in Settings: it reports the upstream error rather than a generic failure",
      ],
    },
    {
      problem: "The gateway itself won't install, start, or let me in",
      solutions: [
        "'npm is not recognized': Node.js is not installed. Install Node, close and reopen the terminal, then run npm install -g omniroute again.",
        "'omniroute is not recognized' after a successful install: npm's global folder is not on your PATH. Close and reopen the terminal first — that fixes it most of the time.",
        "Permission errors during install on macOS or Linux: install Node with a version manager (nvm) rather than using sudo with npm.",
        "Port 20128 already in use: an older copy of the gateway is still running. Close its terminal window, or restart the machine, then start it again.",
        "The dashboard asks for a password and CHANGEME is refused: that means INITIAL_PASSWORD was set to something else before the gateway first started, or the password was already changed. CHANGEME is only the factory default.",
        "Your OmniRoute Coder password does not work on the gateway dashboard, and vice versa. They are two separate programs with two separate accounts — this is expected, not a bug.",
        "Change the gateway password from CHANGEME before you put it behind a tunnel. A tunnel address is public, and anyone who finds it can otherwise sign in and use your provider accounts.",
      ],
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-2xl font-bold text-white mb-2">Troubleshooting</h3>
        <p className="text-zinc-400">
          Common issues and their solutions. If problems persist, check the logs
          or reach out for support.
        </p>
      </div>

      <div className="space-y-4">
        {issues.map((issue, idx) => (
          <motion.div
            key={idx}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: idx * 0.05 }}
            className="bg-zinc-800/30 border border-zinc-700 rounded-xl p-5"
          >
            <h4 className="text-lg font-semibold text-white mb-3 flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-400" />
              {issue.problem}
            </h4>
            <div className="space-y-2">
              {issue.solutions.map((solution, sidx) => (
                <div
                  key={sidx}
                  className="flex items-start gap-3 text-sm text-zinc-300"
                >
                  <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" />
                  <span>{solution}</span>
                </div>
              ))}
            </div>
          </motion.div>
        ))}
      </div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="bg-blue-500/10 border border-blue-500/30 rounded-xl p-6"
      >
        <h4 className="text-lg font-semibold text-white mb-3 flex items-center gap-2">
          <Info className="w-5 h-5 text-blue-400" />
          Still Need Help?
        </h4>
        <p className="text-zinc-300 mb-4">
          If you're experiencing issues not covered here:
        </p>
        <ul className="space-y-2">
          {[
            "Check the browser console for error messages (F12)",
            "Review the application logs in the terminal",
            "Verify your .env.local configuration",
            "Try clearing browser cache and restarting",
            "Check GitHub issues for known problems",
          ].map((item, idx) => (
            <li key={idx} className="flex items-start gap-2 text-sm text-zinc-300">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-1.5 flex-shrink-0" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </motion.div>
    </div>
  );
}

// Additional helper components (RefreshCw is already imported)
const RefreshCw = ({ className }: { className?: string }) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
    />
  </svg>
);
