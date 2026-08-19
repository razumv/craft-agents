import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.symphony.VALIDATE,
  RPC_CHANNELS.symphony.SHADOW,
  RPC_CHANNELS.symphony.PROJECT_DESK,
  RPC_CHANNELS.symphony.TICK,
  RPC_CHANNELS.symphony.STATUS,
  RPC_CHANNELS.symphony.STOP,
  RPC_CHANNELS.symphony.GENERATE_CONFIG,
  RPC_CHANNELS.symphony.REFRESH,
  RPC_CHANNELS.symphony.CREATE_ISSUE,
] as const

function projectId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Symphony projectId is required')
  return value.trim()
}

export function registerSymphonyHandlers(server: RpcServer, deps: HandlerDeps): void {
  const service = deps.symphonyService
  if (!service) return

  server.handle(RPC_CHANNELS.symphony.VALIDATE, async (_ctx, id: unknown) => service.validate(projectId(id)))
  server.handle(RPC_CHANNELS.symphony.SHADOW, async (_ctx, id: unknown) => service.shadow(projectId(id)))
  server.handle(RPC_CHANNELS.symphony.PROJECT_DESK, async (_ctx, id: unknown) => service.projectDesk(projectId(id)))
  server.handle(RPC_CHANNELS.symphony.REFRESH, async (_ctx, id: unknown) => service.refresh(projectId(id)))
  server.handle(RPC_CHANNELS.symphony.CREATE_ISSUE, async (_ctx, id: unknown, input: unknown) => service.createIssue(projectId(id), input))

  // Live board updates: broadcast after every completed operation (tick, loop
  // shadow cycles, refresh, intake) so open boards re-read status themselves.
  service.subscribe?.((changedProjectId, operation) => {
    pushTyped(server, RPC_CHANNELS.symphony.CHANGED, { to: 'all' }, { projectId: changedProjectId, operation })
  })
  server.handle(RPC_CHANNELS.symphony.TICK, async (_ctx, id: unknown) => service.tick(projectId(id)))
  server.handle(RPC_CHANNELS.symphony.STATUS, async () => service.status())
  // Generate discovery runner-config DRAFTS from a Craft project's GitHub
  // binding. Read-only against GitHub; writes only draft JSON files under the
  // local ~/.craft-agent/symphony/drafts directory. Never touches the Symphony
  // server config — wiring a draft in stays an explicit owner decision.
  server.handle(
    RPC_CHANNELS.symphony.GENERATE_CONFIG,
    async (_ctx, workspaceId: unknown, projectSlug: unknown) => {
      if (typeof workspaceId !== 'string' || !workspaceId.trim()) throw new Error('workspaceId is required')
      if (typeof projectSlug !== 'string' || !projectSlug.trim()) throw new Error('projectSlug is required')
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
      const { loadProjectConfig } = await import('@craft-agent/shared/projects')
      const project = loadProjectConfig(workspace.rootPath, projectSlug)
      if (!project) throw new Error(`Project not found: ${projectSlug}`)
      if (!project.github?.repositories?.length) {
        throw new Error('Project has no GitHub binding — set repositories in project settings first')
      }
      const { generateDiscoveryRunnerConfigs, GhCliTransport, FENCE_ISSUE_LABEL } = await import('@craft-agent/symphony')
      const gh = new GhCliTransport('gh')
      const drafts = await generateDiscoveryRunnerConfigs(
        {
          repositories: project.github.repositories,
          projectUrl: project.github.projectUrl,
          projectView: project.github.projectView,
        },
        { id: project.id, slug: project.slug, workingDirectory: project.workingDirectory },
        {
          resolveProject: (url) => gh.resolveProject(url),
          findFenceIssue: (repository) => gh.findFenceIssue(repository, FENCE_ISSUE_LABEL),
        },
      )
      const draftsDir = join(homedir(), '.craft-agent', 'symphony', 'drafts')
      await mkdir(draftsDir, { recursive: true })
      const written = await Promise.all(drafts.map(async (draft) => {
        const fileName = `${project.slug}-${draft.repository.replace('/', '_')}.runner.json`
        const path = join(draftsDir, fileName)
        await writeFile(path, JSON.stringify(draft.config, null, 2) + '\n')
        return { repository: draft.repository, path, warnings: draft.warnings }
      }))
      return { projectSlug: project.slug, drafts: written }
    },
  )

  server.handle(RPC_CHANNELS.symphony.STOP, async (_ctx, timeoutMs?: unknown) => {
    if (timeoutMs === undefined) return service.stop()
    if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1) {
      throw new Error('Symphony stop timeoutMs must be a positive integer')
    }
    return service.stop(timeoutMs as number)
  })
}
