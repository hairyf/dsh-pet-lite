/**
 * client/ui.ts — 边界自适配层（`dsh-tauri-ui/client` 的同形最小子集）。
 *
 * 上游 `builtin-plugin-pet` 的设置页使用 dsh-tauri-ui 的组件：
 * `Button` / `Input` / `Modal` / `SegmentedControl` / `Switch` / `Action` / `Icon`，
 * 以及 `Plus` / `Globe` / `TrashBin` / `Ghost` / `ArrowRightFromSquare` 几个图标。
 *
 * 那个包同样是 desktop monorepo 的未发布 workspace 包（`dsh-tauri-ui@1.0.0`）。这里把
 * **同形 props** 落到官方 `@deepseek-ai/dsh-client-ui-primitives` 的真组件上：
 *
 * - 组件语义与可访问性由官方组件承担，不手写替代品；
 * - 差异只在 props 形状（上游 `variant`/`size`/`icon` 与官方同名同义，`label` 位置不同）；
 * - `Icon as={X}` 的上游写法改成本地 `Icon` 包装：接受官方图标组件，统一 `size`。
 *
 * 这样上游 `pet-settings.tsx` / `pet-card.tsx` 的 JSX 可以逐字保留。
 */

import type { ComponentType, ReactElement, ReactNode } from 'react'
import {
  IconGlobeOutlineRegular,
  IconPlusOutlineRegular,
  IconTrashOutlineRegular,
  Button as OfficialButton,
  Input as OfficialInput,
  Modal as OfficialModal,
  SegmentedControl as OfficialSegmentedControl,
  Switch as OfficialSwitch,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** 官方图标的通用形状（`{ size?, className? }`）。 */
export interface IconArtworkProps {
  size?: number | undefined
  className?: string | undefined
}

export { OfficialButton as Button, OfficialInput as Input, OfficialSegmentedControl as SegmentedControl }

/**
 * `Modal`：上游用 `open/onClose/title/description/closeLabel/footer`。
 *
 * 官方 `Modal` 需要 `closeLabel` 或 `headless`；直接转发即可，形状一致。
 */
export function Modal(props: {
  children?: ReactNode
  className?: string
  closeLabel: string
  description?: string
  footer?: ReactNode
  onClose: () => void
  open: boolean
  title: string
}): ReactElement {
  return (
    <OfficialModal
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      description={props.description}
      closeLabel={props.closeLabel}
      footer={props.footer}
      className={props.className}
    >
      {props.children}
    </OfficialModal>
  )
}

/**
 * `Switch`：上游调用形如 `<Switch checked onChange label />`。
 *
 * 官方 `Switch` 要求受控 `checked` + `label`（可访问名），形状一致，直接转发。
 */
export function Switch(props: {
  checked: boolean
  className?: string
  disabled?: boolean
  label: string
  onChange: (next: boolean) => void
  title?: string
}): ReactElement {
  return (
    <OfficialSwitch
      checked={props.checked}
      onChange={props.onChange}
      label={props.label}
      disabled={props.disabled}
      title={props.title}
      className={props.className}
    />
  )
}

/** `Action`：上游的无边框图标按钮。官方用 `Button variant="ghost" size="sm"`。 */
export function Action(props: {
  'aria-label'?: string
  'children'?: ReactNode
  'className'?: string
  'disabled'?: boolean
  'onClick'?: () => void
  'title'?: string
  'variant'?: 'action'
}): ReactElement {
  return (
    <OfficialButton
      type="button"
      variant="ghost"
      size="sm"
      aria-label={props['aria-label']}
      title={props.title}
      disabled={props.disabled}
      className={props.className}
      onClick={props.onClick}
    >
      {props.children}
    </OfficialButton>
  )
}

/**
 * `Icon`：上游写法 `<Icon size={14} as={Plus} />`。
 *
 * 上游把「图标集」作为可替换的 `as` 传入；这里接受官方图标组件，渲染时只转发
 * `size` 与 `className`，其余图标自带。
 */
export function Icon(props: { as?: ComponentType<IconArtworkProps>, className?: string, size?: number }): ReactElement | null {
  const Artwork = props.as
  if (!Artwork)
    return null
  return <Artwork size={props.size} className={props.className} />
}

// 上游图标名 → 官方图标组件（语义等价替换）。
export const Plus = IconPlusOutlineRegular
export const Globe = IconGlobeOutlineRegular
export const TrashBin = IconTrashOutlineRegular
/** 上游菜单项图标（幽灵）：官方没有同名图标，用「新增/标记」类中性图形替代。 */
export const Ghost = IconPlusOutlineRegular
/** 上游外链图标：同上，用地球图标表达「跳转外部站点」。 */
export const ArrowRightFromSquare = IconGlobeOutlineRegular
