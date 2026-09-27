import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const artifacts = process.env.EXPLAINWEAVE_BROWSER_ARTIFACTS ?? join(tmpdir(), 'explainweave-browser-artifacts');

async function boot(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('region', { name: '平均数', exact: true })).toBeVisible();
  return errors;
}

for (const size of [{ name: 'wide', width: 1440, height: 1000 }, { name: 'narrow', width: 420, height: 900 }]) {
  test(`${size.name}: question → evidence → reading state → edit → review → undo`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    const errors = await boot(page);
    const first = page.getByRole('region', { name: '平均数', exact: true });
    const second = page.getByRole('region', { name: '极端值', exact: true });
    await first.getByRole('button', { name: '对此提问', exact: true }).click();
    await first.getByRole('textbox', { name: '读到这里，你有什么疑问？' }).fill('为什么一个极端值会影响结果？');
    await first.getByRole('button', { name: '记录问题' }).click();
    await expect(first.locator('.ew-status')).toHaveText('未解释');

    await second.getByText('更多', { exact: true }).click();
    await second.getByRole('button', { name: '关联前文问题的解释' }).click();
    await second.getByRole('textbox', { name: '具体解释原文' }).fill('一个数值变大，会抬高总和，从而抬高平均数。');
    await second.getByRole('combobox', { name: '解释覆盖范围' }).selectOption('full');
    await second.getByRole('button', { name: '关联解释', exact: true }).click();
    await expect(first.locator('.ew-status')).toHaveText('未解释');
    await expect(first.getByText('后文有解释 ↗')).toBeVisible();

    await second.getByRole('button', { name: '记住此处' }).click();
    await expect(first.locator('.ew-status')).toHaveText('已解释');
    await second.getByRole('button', { name: '编辑', exact: true }).click();
    const editor = second.getByRole('textbox', { name: '编辑 极端值' });
    await editor.fill('# 极端值\n\n中文修改：这一段暂时没有给出原来的解释。\n\n');
    // Changes are local until explicit save, even with real contenteditable input.
    await expect(first.locator('.ew-status')).toHaveText('已解释');
    await second.getByRole('button', { name: '保存正文' }).click();
    await expect(first.locator('.ew-status')).toHaveText('待检查');
    await expect(second.getByText('中文修改：这一段暂时没有给出原来的解释。', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(first.locator('.ew-status')).toHaveText('已解释');
    await expect(second.getByText('一个数值变大，会抬高总和，从而抬高平均数。即使其他数没有变化，这一步也会改变结果。', { exact: false })).toBeVisible();

    await first.getByRole('button', { name: /为什么一个极端值会影响结果/ }).click();
    await expect(page.getByRole('complementary', { name: '问题支线' })).toBeVisible();
    await expect(page.getByRole('button', { name: '回到主线 ↩' })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: `${artifacts}/${size.name}.png`, fullPage: true });
    await page.getByRole('button', { name: '回到主线 ↩' }).click();
    await expect(page.getByRole('complementary', { name: '问题支线' })).toHaveCount(0);
    await expect(second.locator('.ew-reading-marker')).toHaveText('读到这里');
    expect(errors).toEqual([]);
  });
}

test('streaming permits editing, cancellation preserves output, and stale output cannot be adopted', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  const errors = await boot(page);
  const first = page.getByRole('region', { name: '平均数', exact: true });
  await first.getByRole('button', { name: '补充解释（模拟）' }).click();
  await expect(first.getByRole('button', { name: '取消生成' })).toBeVisible();
  await expect(first.locator('.ew-draft .ew-prose')).not.toBeEmpty();
  await first.getByRole('button', { name: '编辑', exact: true }).click();
  const editor = first.getByRole('textbox', { name: '编辑 平均数' });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('生成时仍可输入中文。\n');
  await first.getByRole('button', { name: '保存正文' }).click();
  await expect(first.getByRole('button', { name: '取消生成' })).toBeVisible();
  await first.getByRole('button', { name: '取消生成' }).click();
  await expect(first.getByRole('button', { name: '取消生成' })).toHaveCount(0);
  await expect(first.locator('.ew-draft .ew-prose')).not.toBeEmpty();
  await expect(first.getByRole('button', { name: '采用为后续解释' })).toBeDisabled();
  await expect(first.getByText('生成草稿后，相关正文已经改变。请重新生成，避免采用过期内容。')).toBeVisible();
  await expect(first.locator('.ew-prose').first()).toContainText('生成时仍可输入中文。');
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: `${artifacts}/generation-cancelled.png`, fullPage: true });
  expect(errors).toEqual([]);
});
