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

type Placement = "sidebar-content" | "sidebar-footer"

type PluginConfig = {
    placement?: Placement
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

function abbreviateHome(path: string): string {
    const home = homedir()
    if (path === home) return "~"
    if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`
    return path
}

function resolvePlacement(options: unknown): Placement {
    const placement = (options as PluginConfig | undefined)?.placement
    return placement === "sidebar-content" ? "sidebar-content" : "sidebar-footer"
}

function SidebarUsage(props: {
    api: TuiPluginApi
    accent: string
    muted: string
    sessionID: string
    placement: Placement
}) {
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

    const footerPath = () => {
        const session = props.api.state.session.get(props.sessionID)
        const dir = session?.directory || props.api.state.path.directory || props.api.state.path.worktree
        const branch = session?.directory === props.api.state.path.directory ? props.api.state.vcs?.branch : undefined
        const text = branch ? `${abbreviateHome(dir)}:${branch}` : abbreviateHome(dir)
        const parts = text.split("/")

        return {
            parent: parts.slice(0, -1).join("/"),
            name: parts.at(-1) ?? "",
        }
    }

    if (props.placement === "sidebar-content") {
        return (
            <box flexDirection="column">
                <text fg={props.api.theme.current.text}>
                    <b>Codex Usage</b>
                </text>
                <text fg={props.accent}>{summary()}</text>
            </box>
        )
    }

    return (
        <box gap={1}>
            <text>
                <span style={{ fg: props.api.theme.current.textMuted }}>{footerPath().parent}/</span>
                <span style={{ fg: props.api.theme.current.text }}>{footerPath().name}</span>
            </text>
            <box flexDirection="column">
                <text fg={props.api.theme.current.text}>
                    <b>Codex Usage</b>
                </text>
                <text fg={props.accent}>{summary()}</text>
            </box>
        </box>
    )
}

const tui: TuiPlugin = async (api, options) => {
    const placement = resolvePlacement(options)
    const order = placement === "sidebar-footer" ? 50 : 1000

    api.slots.register({
        order,
        slots: {
            sidebar_content(_ctx, props) {
                if (placement !== "sidebar-content") return null
                return <SidebarUsage api={api} accent={api.theme.current.accent} muted={api.theme.current.textMuted} sessionID={props.session_id} placement={placement} />
            },
            sidebar_footer(_ctx, props) {
                if (placement !== "sidebar-footer") return null
                return <SidebarUsage api={api} accent={api.theme.current.accent} muted={api.theme.current.textMuted} sessionID={props.session_id} placement={placement} />
            },
        },
    })
}

export default {
    id: "codex-usage",
    tui,
} satisfies TuiPluginModule
