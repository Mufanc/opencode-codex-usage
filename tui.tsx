/** @jsxImportSource @opentui/solid */

import { createSignal, onCleanup, onMount } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { homedir } from "node:os"
import { join } from "node:path"
import { readFile } from "node:fs/promises"

type UsageWindow = {
    label: string
    remainingPercent: number
    resetValue: number
    unit: "h" | "d"
}

type OpenAIAuth = {
    type: "oauth"
    access: string
}

type AuthFile = {
    openai?: OpenAIAuth
}

type RateLimitWindow = {
    used_percent: number
    limit_window_seconds: number
    reset_after_seconds: number
}

type UsageResponse = {
    rate_limit?: {
        primary_window?: RateLimitWindow
        secondary_window?: RateLimitWindow
    }
}

const AUTH_PATH = join(homedir(), ".local", "share", "opencode", "auth.json")
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
const REFRESH_THROTTLE_MS = 60_000
const WORKSPACE_READY_DELAY_MS = 5_000
const SUMMARY_KV_KEY = "codex-usage.summary"
const LAST_REFRESH_AT_KV_KEY = "codex-usage.lastRefreshAt"

async function readAuthFile(): Promise<AuthFile> {
    return JSON.parse(await readFile(AUTH_PATH, "utf8")) as AuthFile
}

async function getOpenAIAccessToken(): Promise<string> {
    const auth = (await readAuthFile()).openai

    if (!auth || auth.type !== "oauth" || !auth.access) {
        throw new Error("OpenAI OAuth not available in auth.json")
    }

    return auth.access
}

async function fetchUsage(): Promise<UsageResponse> {
    const accessToken = await getOpenAIAccessToken()
    const response = await fetch(USAGE_URL, {
        headers: {
            accept: "*/*",
            authorization: `Bearer ${accessToken}`,
            "x-openai-target-path": "/backend-api/wham/usage",
            "x-openai-target-route": "/backend-api/wham/usage",
        },
    })

    if (!response.ok) {
        throw new Error(`Usage request failed: ${response.status}`)
    }

    return (await response.json()) as UsageResponse
}

function toUsageWindow(label: string, window: RateLimitWindow | undefined): UsageWindow | null {
    if (!window) return null

    return {
        label,
        remainingPercent: Math.max(0, 100 - window.used_percent),
        resetValue: label === "5h" ? window.reset_after_seconds / 3600 : window.reset_after_seconds / 86400,
        unit: label === "5h" ? "h" : "d",
    }
}

function formatUsageWindows(usage: UsageResponse): string {
    const windows = [
        toUsageWindow("5h", usage.rate_limit?.primary_window),
        toUsageWindow("Wk", usage.rate_limit?.secondary_window),
    ].filter((window): window is UsageWindow => window !== null)

    if (windows.length === 0) return "Unavailable"
    return windows.map(formatWindow).join(" ")
}

function formatWindow(window: UsageWindow): string {
    return `${window.label}(${window.remainingPercent}%,${window.resetValue.toFixed(2)}${window.unit})`
}

function FooterUsage(props: { api: TuiPluginApi; accent: string; muted: string }) {
    const cachedSummary = props.api.kv.get<string | undefined>(SUMMARY_KV_KEY)
    const [summary, setSummary] = createSignal(cachedSummary ?? "Loading...")
    let refreshing: Promise<void> | undefined
    const pendingTimeouts = new Set<ReturnType<typeof setTimeout>>()

    const refresh = async () => {
        try {
            const nextSummary = formatUsageWindows(await fetchUsage())
            const refreshedAt = Date.now()

            setSummary(nextSummary)
            props.api.kv.set(SUMMARY_KV_KEY, nextSummary)
            props.api.kv.set(LAST_REFRESH_AT_KV_KEY, refreshedAt)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            setSummary(`Error: ${message}`)
        }
    }

    const refreshIfStale = async () => {
        if (refreshing) return refreshing

        const lastRefreshAt = props.api.kv.get<number>(LAST_REFRESH_AT_KV_KEY, 0)
        if (Date.now() - lastRefreshAt <= REFRESH_THROTTLE_MS) return

        refreshing = refresh().finally(() => {
            refreshing = undefined
        })

        return refreshing
    }

    const scheduleRefreshIfStale = (delayMs: number) => {
        const timeout = setTimeout(() => {
            pendingTimeouts.delete(timeout)
            void refreshIfStale()
        }, delayMs)

        pendingTimeouts.add(timeout)
    }

    onMount(() => {
        const disposeWorkspaceReady = props.api.event.on("workspace.ready", () => {
            scheduleRefreshIfStale(WORKSPACE_READY_DELAY_MS)
        })
        const disposeSessionIdle = props.api.event.on("session.idle", () => {
            void refreshIfStale()
        })

        onCleanup(() => {
            disposeWorkspaceReady()
            disposeSessionIdle()
            for (const timeout of pendingTimeouts) clearTimeout(timeout)
            pendingTimeouts.clear()
        })
    })

    return (
        <box flexDirection="column">
            <text fg={props.muted}>Codex Usage</text>
            <text fg={props.accent}>{summary()}</text>
        </box>
    )
}

const tui: TuiPlugin = async (api) => {
    api.slots.register({
        order: 50,
        slots: {
            sidebar_footer() {
                return (
                    <FooterUsage api={api} accent={api.theme.current.accent} muted={api.theme.current.textMuted} />
                )
            },
        },
    })
}

export default {
    id: "codex-usage",
    tui,
} satisfies TuiPluginModule
