import { PLUGIN_ID } from '../../shared/constants'
import { PetSettings } from '../components/pet-settings'
import { PET_SECTION_ID, PET_SECTION_ORDER } from '../constants'
import { locale } from '../locales'
import { defineRegister } from '../sdk'
import { createPetSession } from '../service/pet'

/**
 * settings.section 里的桌宠设置分区。
 *
 * 上游用 `ctx.slots.inject(name, () => ctx.slots.register({...}, Component))`：先把
 * 注册挂到「槽位声明就绪」上，再交注册选项。这里保留同形写法 —— 官方 `slots.inject`
 * 的存在意义正是「等声明出现」，直接 register 会在装配顺序不利时静默丢失。
 */
export const petSectionFeature = defineRegister((controller, ctx, adapter) => {
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
