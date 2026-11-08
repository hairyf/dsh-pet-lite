/**
 * placement.ts — 桌宠包围盒的屏幕落点（屏幕坐标 / DIP）。
 *
 * 坐标约定与 `renderer/index.tsx` 的 `View` 完全一致：`x` / `y` 是**宠物包围盒左上角**，
 * 不是窗口位置（窗口 = 宠物 − 窗口内偏移，见 `applyPosition`）。
 *
 * 单独成模块是为了能测：这里错一次，用户看到的就是「启动后宠物贴在屏幕角上被裁掉」。
 */

/** 工作区（显示器可用区域，屏幕坐标）。 */
export interface PetArea {
  x: number
  y: number
  width: number
  height: number
}

/** 宠物包围盒左上角（屏幕坐标）。 */
export interface PetPosition {
  x: number
  y: number
}

/**
 * 夹成**整只可见**：宠物包围盒必须完整落在工作区里（`inset` 是四周额外的安全边距）。
 *
 * 工作区比宠物还小时退化成左上角（与 `physics.throwBoundsIn` 的上下限处理一致：
 * 上限小于下限时取上限，不产生空区间）。
 */
export function clampPetPosition(
  position: PetPosition,
  petWidth: number,
  petHeight: number,
  area: PetArea,
  inset = 0,
): PetPosition {
  const minX = area.x + inset
  const minY = area.y + inset
  const maxX = Math.max(minX, area.x + area.width - petWidth - inset)
  const maxY = Math.max(minY, area.y + area.height - petHeight - inset)
  return {
    x: Math.round(Math.min(Math.max(position.x, minX), maxX)),
    y: Math.round(Math.min(Math.max(position.y, minY), maxY)),
  }
}

/**
 * 默认落点：工作区右下角，距右 / 下边缘各 `inset`（再夹一次防小屏溢出）。
 *
 * 上游 `place_pet_at_default` 同样把桌宠摆在工作区右下角并按宠物尺寸留边距；这里按
 * **包围盒**算而不是按窗口算，因为窗口四周还有透明留白（气泡画布 + 命中余量）。
 */
export function cornerPetPosition(
  petWidth: number,
  petHeight: number,
  area: PetArea,
  inset: number,
): PetPosition {
  return clampPetPosition(
    {
      x: area.x + area.width - petWidth - inset,
      y: area.y + area.height - petHeight - inset,
    },
    petWidth,
    petHeight,
    area,
    inset,
  )
}
