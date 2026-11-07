import type { Root } from 'react-dom/client'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { PLUGIN_ID } from '../../shared/constants'
import { PetSettings } from '../components/pet-settings'
import { PET_SECTION_ID, PET_SECTION_ORDER } from '../constants'
import { locale } from '../locales'
import { defineRegister } from '../sdk'
import { createPetSession } from '../service/pet'
import { Ghost, Icon } from '../ui'

const ICON_ROOTS = new WeakMap<HTMLElement, Root>()

function patchSettingsSectionIcon(): void {
  const label = locale.text('name').trim()
  for (const button of document.querySelectorAll<HTMLButtonElement>('nav button')) {
    const text = button.textContent?.trim()
    if (text !== label)
      continue
    const icon = button.firstElementChild
    if (!(icon instanceof Element))
      continue
    if (button.querySelector('[data-pet-ghost-icon]') !== null)
      continue
    const iconHost = document.createElement('span')
    iconHost.className = icon.getAttribute('class') || 'flex-none'
    iconHost.setAttribute('data-pet-ghost-icon', '1')
    icon.replaceWith(iconHost)
    ICON_ROOTS.get(iconHost)?.unmount()
    const root = createRoot(iconHost)
    root.render(createElement(Icon, { as: Ghost, size: 16 }))
    ICON_ROOTS.set(iconHost, root)
  }
}

/**
 * settings.section 里的桌宠设置分区。
 *
 * 上游用 `ctx.slots.inject(name, () => ctx.slots.register({...}, Component))`：先把
 * 注册挂到「槽位声明就绪」上，再交注册选项。这里保留同形写法 —— 官方 `slots.inject`
 * 的存在意义正是「等声明出现」，直接 register 会在装配顺序不利时静默丢失。
 */
export const petSectionFeature = defineRegister((controller, ctx, adapter) => {
  if (typeof document !== 'undefined')
    controller.observe(document.body, patchSettingsSectionIcon, { childList: true, subtree: true })
  controller.add(ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section',
      id: PET_SECTION_ID,
      order: PET_SECTION_ORDER,
      registrant: PLUGIN_ID,
      label: () => locale.text('name'),
      inject: (close?: () => void) => ({
        onCreate: () => createPetSession({ adapter, close }),
      }),
    } as never,
    PetSettings as never,
  )))
})
