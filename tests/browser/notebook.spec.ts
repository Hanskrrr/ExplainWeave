import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const artifacts = process.env.EXPLAINWEAVE_BROWSER_ARTIFACTS ?? join(tmpdir(), 'explainweave-browser-artifacts');

async function boot(page: Page, query = '') {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`/${query}`);
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
  await expect(first.getByText('正在组织候选节点与解释关联…')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).explainweaveTestState.drafts[0]?.markdown.length ?? 0)).toBeGreaterThan(0);
  await first.getByRole('button', { name: '编辑', exact: true }).click();
  const editor = first.getByRole('textbox', { name: '编辑 平均数' });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('生成时仍可输入中文。\n');
  await first.getByRole('button', { name: '保存正文' }).click();
  await expect(first.getByRole('button', { name: '取消生成' })).toBeVisible();
  await first.getByRole('button', { name: '取消生成' }).click();
  await expect(first.getByRole('button', { name: '取消生成' })).toHaveCount(0);
  await expect(first.getByText('候选节点未通过完整性与解释依据校验，请重新生成。')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).explainweaveTestState.drafts[0]?.markdown.length ?? 0)).toBeGreaterThan(0);
  await expect(first.getByRole('button', { name: '采用为后续解释' })).toBeDisabled();
  await expect(first.getByText('生成草稿后，相关正文已经改变。请重新生成，避免采用过期内容。')).toBeVisible();
  await expect(first.locator('.ew-prose').first()).toContainText('生成时仍可输入中文。');
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: `${artifacts}/generation-cancelled.png`, fullPage: true });
  expect(errors).toEqual([]);
});

for (const size of [{ name: 'wide', width: 1440, height: 1000 }, { name: 'narrow', width: 420, height: 900 }]) {
  test(`${size.name}: persistent question discussion → future plan → proposed evidence → adoption`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    const errors = await boot(page, '?backend=fixture');
    const first = page.getByRole('region', { name: '平均数', exact: true });
    const second = page.getByRole('region', { name: '极端值', exact: true });
    await first.getByRole('button', { name: '对此提问', exact: true }).click();
    await first.getByRole('textbox', { name: '读到这里，你有什么疑问？' }).fill('为什么极端值会改变平均数？');
    await first.getByRole('button', { name: '记录问题' }).click();
    await first.getByRole('button', { name: /为什么极端值会改变平均数/ }).click();
    const panel = page.getByRole('complementary', { name: '问题支线' });
    await panel.getByRole('textbox', { name: '继续讨论这个问题' }).fill('从总和的定义开始解释。');
    await panel.getByRole('button', { name: '发送', exact: true }).click();
    await expect(panel.locator('.ew-chat-turn-assistant').last()).toContainText('本次带入 0 条先前回答');
    await expect(panel.getByRole('button', { name: '取消回答' })).toHaveCount(0);
    await panel.getByRole('textbox', { name: '继续讨论这个问题' }).fill('再举一个三个数的例子。');
    await panel.getByRole('button', { name: '发送', exact: true }).click();
    await expect(panel.locator('.ew-chat-turn-assistant').last()).toContainText('本次带入 1 条先前回答');
    await expect(panel.getByRole('button', { name: '取消回答' })).toHaveCount(0);
    await panel.getByRole('button', { name: '安排在后续节点解释' }).click();
    await panel.getByRole('combobox', { name: '安排在哪个后续节点？' }).selectOption({ label: '极端值' });
    await panel.getByRole('textbox', { name: '安排原因（可选）' }).fill('先讲清楚总和，再承接这个问题。');
    await panel.getByRole('button', { name: '保存安排' }).click();
    await expect(panel.getByText('待处理 · 安排在「极端值」解释')).toBeVisible();
    await expect(first.locator('.ew-status')).toHaveText('未解释');
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: `${artifacts}/discussion-${size.name}.png`, fullPage: true });
    await panel.getByRole('button', { name: '回到主线 ↩' }).click();
    await second.getByRole('button', { name: '解释这些问题' }).click();
    await expect(second.getByRole('button', { name: '采用为后续解释' })).toBeEnabled();
    await expect(second.getByText('拟完整解释')).toBeVisible();
    await expect(first.locator('.ew-status')).toHaveText('未解释');
    await second.getByRole('button', { name: '采用为后续解释' }).click();
    await expect(first.getByText('后文有解释 ↗')).toBeVisible();
    const inserted = page.getByRole('region', { name: '候选解释', exact: true });
    await inserted.getByRole('button', { name: '记住此处' }).click();
    await expect(first.locator('.ew-status')).toHaveText('已解释');
    await expect(inserted.getByText('这一节点提供的解释')).toBeVisible();
    await page.evaluate(() => (window as any).reopenExplainweaveFixture());
    await first.getByRole('button', { name: /为什么极端值会改变平均数/ }).click();
    await expect(panel.locator('.ew-chat-turn-user')).toHaveCount(2);
    await expect(panel.locator('.ew-chat-turn-assistant')).toHaveCount(2);
    expect(errors).toEqual([]);
  });
}

test('article chat can be continued, composed at a chosen position, and reopened', async ({ page }) => {
  const errors = await boot(page, '?backend=fixture');
  await page.getByRole('button', { name: '讨论这篇文章', exact: true }).click();
  const panel = page.getByRole('complementary', { name: '文章讨论面板' });
  await panel.getByRole('textbox', { name: '讨论这篇文章' }).fill('文章逻辑是否完整？');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect(panel.locator('.ew-chat-turn-assistant')).toContainText('本次带入 0 条先前回答');
  await expect(panel.getByRole('button', { name: '取消回答' })).toHaveCount(0);
  await panel.getByRole('button', { name: '整理成正文节点' }).click();
  await panel.getByRole('combobox', { name: '插入到哪个节点之后？' }).selectOption({ label: '2. 极端值' });
  await panel.getByRole('textbox', { name: '整理要求（可选）' }).fill('补上必要的过渡。');
  await panel.getByRole('button', { name: '生成正文草稿' }).click();
  const second = page.getByRole('region', { name: '极端值', exact: true });
  await expect(second.getByRole('button', { name: '采用为后续解释' })).toBeEnabled();
  await expect(page.getByText('3 个节点 · 0 个问题')).toBeVisible();
  await expect(panel.locator('.ew-chat-turn-assistant')).toHaveCount(2);
  await page.evaluate(() => (window as any).reopenExplainweaveFixture());
  await page.getByRole('button', { name: '讨论这篇文章', exact: true }).click();
  await expect(panel.locator('.ew-chat-turn-user')).toHaveCount(2);
  await expect(panel.locator('.ew-chat-turn-assistant')).toHaveCount(2);
  await expect(second.getByRole('button', { name: '采用为后续解释' })).toBeEnabled();
  expect(errors).toEqual([]);
});

test('a child question inherits its parent discussion and AI insertion accepts an intention', async ({ page }) => {
  const errors = await boot(page, '?backend=fixture');
  const first = page.getByRole('region', { name: '平均数', exact: true });
  await first.getByRole('button', { name: '对此提问', exact: true }).click();
  await first.getByRole('textbox', { name: '读到这里，你有什么疑问？' }).fill('为什么要除以个数？');
  await first.getByRole('button', { name: '记录问题' }).click();
  await first.getByRole('button', { name: /为什么要除以个数/ }).click();
  const panel = page.getByRole('complementary', { name: '问题支线' });
  await panel.getByRole('textbox', { name: '继续讨论这个问题' }).fill('请给出直觉。');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect(panel.locator('.ew-chat-turn-assistant')).toContainText('本次带入 0 条先前回答');
  await expect(panel.getByRole('button', { name: '取消回答' })).toHaveCount(0);
  await panel.getByRole('button', { name: '继续追问', exact: true }).click();
  await panel.getByRole('textbox', { name: '从这个问题继续追问' }).fill('如果样本有权重呢？');
  await panel.getByRole('button', { name: '记录追问' }).click();
  await panel.getByRole('button', { name: /如果样本有权重呢/ }).click();
  await expect(panel.getByText('继承父问题讨论 · 2 条记录')).toBeVisible();
  await panel.getByRole('textbox', { name: '继续讨论这个问题' }).fill('请接着上一条解释。');
  await panel.getByRole('button', { name: '发送', exact: true }).click();
  await expect(panel.locator('.ew-chat-transcript > .ew-chat-turn-assistant')).toContainText('本次带入 1 条先前回答');
  await expect(panel.getByRole('button', { name: '取消回答' })).toHaveCount(0);
  await panel.getByRole('button', { name: '回到主线 ↩' }).click();
  await first.getByRole('button', { name: '用 AI 写节点' }).click();
  await first.getByRole('textbox', { name: '希望这里解释什么？' }).fill('用三个具体的数字补上推导。');
  await first.getByRole('button', { name: '生成节点草稿' }).click();
  await expect(first.getByRole('button', { name: '采用为后续解释' })).toBeEnabled();
  await expect(first.getByText('AI 建议解释以下问题')).toBeVisible();
  expect(errors).toEqual([]);
});
