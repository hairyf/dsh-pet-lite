import type { PetStoreFacade } from './modules/pet'
import { createPetStoreFacade, createPetStoreHandle } from './modules/pet'

/**
 * store/index.ts — 插件共享状态的装载点。
 *
 * 官方 `@deepseek-ai/dsh-client-store` 的 handle 必须在 `apply` 世界里构造，不能模块级
 * 导出（模块缓存身份是伪单例，插件重载会串状态）。但上游的调用点（设置页组件、服务层、
 * 菜单补丁）都是直接 `import { store }` 后使用的，因此这里保留一个**装载时绑定**的
 * 单例槽位：
 *
 * - `mountPetStore()` —— 由 `apply` 调一次，构造 handle + 实例 + 读取面；
 * - `store.pet` —— 读取面门面；未装载前访问会抛错（说明装配顺序出了问题，
 *   而不是让状态静默丢失）。
 */

let mounted: PetStoreFacade | undefined

/** 由 `apply` 调用：构造官方 store handle 与实例，绑定读取面。 */
export function mountPetStore(): PetStoreFacade {
  if (mounted)
    return mounted
  const handle = createPetStoreHandle()
  mounted = createPetStoreFacade(handle.create())
  return mounted
}

/** 卸载：丢弃实例（插件 dispose 时调用）。 */
export function unmountPetStore(): void {
  mounted = undefined
}

/** 插件共享状态。 */
export const store = {
  get pet(): PetStoreFacade {
    if (!mounted) {
      throw new Error(
        'PET_STORE_NOT_MOUNTED: the pet store must be mounted by apply() before use',
      )
    }
    return mounted
  },
}
