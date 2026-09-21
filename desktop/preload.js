/**
 * desktop/preload.js
 * ---------------------------------------------------------------------------
 * A deliberately tiny bridge. contextIsolation is on and nodeIntegration is
 * off, so the renderer has no Node access; this exposes only a couple of
 * read-only facts under window.omniroute. It grants NO filesystem, NO shell, and
 * NO arbitrary IPC — anything more would hand the web content powers the threat
 * model does not want it to have.
 */

"use strict";

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("omniroute", {
  isDesktop: true,
  appVersion: process.env.npm_package_version || null,
});
