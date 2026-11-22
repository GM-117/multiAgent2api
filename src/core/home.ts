/**
 * state home 解析 —— **本项目自己的目录**，不跟随外层 DSH。
 *
 * ## 为什么必须与 DSH 隔离（真实故障）
 *
 * 本程序是**独立网关**，不是 DSH 的一部分。第一版错误地沿用了插件的
 * 判据（`DSH_HOME` → `~/.dsh`），于是在一台装过 DSH 的机器上：
 *
 * - 外层 shell 早就设了 `DSH_HOME=/Users/<user>/.dsh`（DSH 自己导出给子进程的），
 *   本程序**继承**了它，把账号池、凭据、网关 Key 全写进了 DSH 的目录；
 * - 两套程序共用一个目录，却又各有各的文件格式（本程序当时写
 *   `jet-hub/credentials.json`，DSH 写 `.credentials.yaml`）——
 *   结果是**账号列表读得到（state.json 格式一致），但每条凭据都读不到**，
 *   界面上表现为「积分/余额一直提示凭据未配置」，且两端会互相覆盖状态。
 *
 * 因此这里**不再读取**外层 `DSH_HOME`，而是把它**覆盖**成我们自己的目录：
 * 插件内部所有落盘点（`resolveJetHubHome` / opencode 能力表缓存 / 网关密钥）
 * 都读 `DSH_HOME`，所以「设置它」是让插件乖乖待在自家目录的唯一办法。
 *
 * ## 优先级
 *
 * 1. `MULTIAGENT2API_HOME` —— 本程序当前的名字（容器里指向挂载卷）；
 * 2. `CODEARTS2API_HOME` —— 旧名字，保留兼容（旧脚本 / 旧 Docker 不炸）；
 * 3. `~/.multiAgent2Api` —— 默认固定路径；
 * 4. `~/.codearts2api` —— **仅当新目录还不存在时**的迁移兜底（避免升级后
 *    用户以为账号丢了）。新目录一旦存在，永远优先用新目录。
 *
 * ⚠️ 默认值刻意**不用 cwd 相对路径**：那样换一个工作目录启动就会读到另一份
 * 账号数据，是极难排查的「账号怎么没了」。
 */

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** 本程序默认的状态目录名（放在用户主目录下）。 */
export const DEFAULT_HOME_DIR = ".multiAgent2Api"

/** 旧版状态目录名（只用于迁移兜底，不再作为默认值）。 */
export const LEGACY_HOME_DIR = ".codearts2api"

/**
 * 解析本程序的状态目录。
 *
 * @param env - 进程环境变量（便于单测注入）。
 * @returns 绝对路径。
 */
export function resolveHome(env = process.env) {
  const configuredNew = env.MULTIAGENT2API_HOME
  if (typeof configuredNew === "string" && configuredNew.trim().length > 0) return configuredNew.trim()

  const configuredLegacy = env.CODEARTS2API_HOME
  if (typeof configuredLegacy === "string" && configuredLegacy.trim().length > 0) return configuredLegacy.trim()

  const next = join(homedir(), DEFAULT_HOME_DIR)
  // 迁移兜底：新默认目录还没建立、旧目录还在时，继续用旧目录。
  // 一旦新目录存在（正常迁移完成后），就永远用新目录。
  const legacy = join(homedir(), LEGACY_HOME_DIR)
  if (!existsSync(next) && existsSync(legacy)) return legacy
  return next
}

/**
 * 把状态目录**钉进环境变量**，让插件与网关都落在自家目录里。
 *
 * ## 为什么要写两个变量
 *
 * 插件里不同的落盘点读的是**不同的**变量，少写一个就会有文件漏到 DSH 目录：
 *
 * | 消费者 | 读的变量 |
 * | --- | --- |
 * | `resolveJetHubHome()`（账号池 / 锁定表 / 偏好 / 签到 / 网关密钥） | `DSH_JET_HUB_STATE_DIR` **优先**，其次 `DSH_HOME` |
 * | `opencode-capability.ts` 的能力表缓存 | `DSH_HOME` |
 *
 * `DSH_JET_HUB_STATE_DIR` 优先级更高，故两个都要设：只设 `DSH_HOME` 时，
 * 用户 shell 里若残留一个 `DSH_JET_HUB_STATE_DIR`（DSH 的测试/多实例开关），
 * 账号池就会写到那个目录，而缓存落到另一个目录 —— 又是「一半对一半错」。
 *
 * @returns 解析出的绝对路径。
 */
export function pinHome(env = process.env) {
  const home = resolveHome(env)
  env.DSH_HOME = home
  env.DSH_JET_HUB_STATE_DIR = home
  return home
}
