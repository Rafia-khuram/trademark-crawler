import { PlaywrightCrawler, createPlaywrightRouter, Dataset, log, NonRetryableError } from 'crawlee';
import { parse } from 'date-fns';
import { Page } from 'playwright';

const enum Selectors {
    FormContainer = '.search-attr-container',
    DateFrom = '#attribute_date_from',
    DateTo = '#attribute_date_to',
    SubmitButton = '.ui-button-secondary .ui-clickable',
    CheckboxInput = 'input[type="checkbox"]',
    TableRowLink = 'table tbody tr td a',
    PaginationNext = 'a.ui-paginator-next:not(.ui-state-disabled)',
    TableBody = 'table tbody',
    ErrorMessage = '.tabs-info-message',
    DetailPanel = 'section.panel',
    DetailsTable = 'table.details-list',
}

const TARGET_CHECKBOXES = [
    'pwp_criteria_0',
    'collections_criteria_advanced_7',
    'collections_criteria_advanced_7_child_attrs_0'
];

const FIELD_MAPPINGS = {
    'Name/Title': 'nameTitle',
    'Status': 'status',
    'Application date': 'applicationDate',
    'Revelation date': 'revelationDate',
    'Application number': 'applicationNumber',
    'Category of rights': 'categoryOfRights',
    'Registration number': 'registrationNumber',
    'Trademark type': 'trademarkType'
};

function validateArgs(): { startDate: string; endDate: string } {
    const args = process.argv.slice(2);
    const [startDate, endDate] = args;

    if (!startDate || !endDate) {
        console.error('Usage: npm start <start_date:YYYY-MM-DD> <end_date:YYYY-MM-DD>');
        process.exit(1);
    }

    const isValidDate = (dateStr: string) => {
        const parsed = parse(dateStr, 'yyyy-MM-dd', new Date());
        return !isNaN(parsed.getTime());
    };

    if (!isValidDate(startDate) || !isValidDate(endDate)) {
        console.error('Invalid date format. Use YYYY-MM-DD.');
        process.exit(1);
    }

    const parsedStart = parse(startDate, 'yyyy-MM-dd', new Date());
    const parsedEnd = parse(endDate, 'yyyy-MM-dd', new Date());

    if (parsedStart > parsedEnd) {
        console.error('Start date must be before or equal to end date.');
        process.exit(1);
    }

    return { startDate, endDate };
}

async function setCheckboxes(page: Page): Promise<void> {
    const checkboxes = await page.$$(Selectors.CheckboxInput);

    for (const checkbox of checkboxes) {
        const id = await checkbox.getAttribute('id');
        if (!id) continue;

        const isChecked = await checkbox.isChecked();
        const shouldBeChecked = TARGET_CHECKBOXES.includes(id);

        if (isChecked !== shouldBeChecked) {
            const box = await checkbox.evaluateHandle(el =>
                el.closest(".ui-chkbox")?.querySelector(".ui-chkbox-box") as HTMLElement
            );
            if (box) {
                await box.click();
                await page.waitForTimeout(100);
            }
        }
    }
}

async function fillDateField(page: Page, selector: string, value: string): Promise<void> {
    await page.click(selector);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.type(selector, value, { delay: 100 });
    await page.waitForTimeout(300);
}

async function performSearch(page: Page, startDate: string, endDate: string): Promise<void> {
    await page.waitForLoadState('networkidle');
    await page.waitForSelector(Selectors.FormContainer, { timeout: 20000 });
    await setCheckboxes(page);
    await fillDateField(page, Selectors.DateFrom, endDate);
    await fillDateField(page, Selectors.DateTo, startDate);

    await Promise.all([
        page.waitForNavigation({ timeout: 15000, waitUntil: 'domcontentloaded' }),
        page.click(Selectors.SubmitButton, { delay: 100 }),
    ]);

    await page.waitForFunction(() => {
        return document.querySelector('.search-table') ||
            document.querySelector('.tabs-info-message');
    },);


    const errorText = await page.$eval(Selectors.ErrorMessage,
        el => el?.textContent?.toLowerCase().trim()
    ).catch(() => null);

    if (errorText?.includes('no results found')) {
        throw new NonRetryableError('No results found for the given criteria');
    }

    if (errorText?.includes('too many results found')) {
        throw new NonRetryableError('Too many results found. Please narrow your search criteria');
    }
}

async function extractDetailData(page: Page): Promise<any> {
    return page.evaluate((fieldMappings) => {
        const result: any = {};

        const rows = document.querySelectorAll('table.details-list tr');

        rows.forEach(row => {
            const cells = row.querySelectorAll('td');

            for (let i = 0; i < cells.length; i += 2) {
                const labelCell = cells[i];
                const valueCell = cells[i + 1];

                if (labelCell?.classList.contains('detail-title') && valueCell) {
                    const labelText = labelCell.textContent?.trim().replace(/\s+/g, ' ') || '';

                    const fieldName = Object.entries(fieldMappings).find(([label]) =>
                        labelText.includes(label)
                    )?.[1];

                    if (fieldName) {
                        const highlightSpan = valueCell.querySelector('.highlight');
                        let value = highlightSpan?.textContent?.trim();

                        if (!value) {
                            value = valueCell.textContent?.trim().replace(/\s+/g, ' ');
                        }

                        result[fieldName] = value || null;
                    }
                }
            }
        });

        return result;
    }, FIELD_MAPPINGS);
}


(async () => {

    const { startDate, endDate } = validateArgs();
    const BASE_URL = 'https://ewyszukiwarka.pue.uprp.gov.pl/search/advanced-search';
    const router = createPlaywrightRouter();

    let formFilled = false;

    router.addDefaultHandler(async ({ page, request, enqueueLinks, log }) => {

        if (request.url.includes('/search/advanced-search') && !formFilled) {
            log.info('Filling out search form...');
            await performSearch(page, startDate, endDate);
            formFilled = true;
        }

        let hasNextPage = true;

        do {
            await enqueueLinks({
                selector: Selectors.TableRowLink,
                label: 'detail',
            });

            const nextButton = await page.$(Selectors.PaginationNext);
            if (nextButton) {
                log.info('Navigating to next page...');
                await nextButton.click();
                await page.waitForTimeout(1500);
            } else {
                log.info('No more pages to paginate.');
                hasNextPage = false;
            }

        } while (hasNextPage);

    });

    router.addHandler('detail', async ({ page, request, log }) => {
        log.info(`📄 Processing detail: ${request.url}`);

        try {
            await page.waitForLoadState('networkidle', { timeout: 20000 });
            await page.waitForSelector(Selectors.DetailPanel, { timeout: 15000 });
            await page.waitForTimeout(1000);

            const data = await extractDetailData(page);

            if (data && Object.keys(data).length) {
                await Dataset.pushData(data);
            } else {
                log.warning(`No data extracted from: ${request.url}`);
            }

        } catch (error) {
            log.error(`Failed to process ${request.url}`);
        }
    });



    const crawler = new PlaywrightCrawler({
        requestHandler: router,
        headless: true,
        navigationTimeoutSecs: 60,
        requestHandlerTimeoutSecs: 180,
    });

    await crawler.run([{ url: BASE_URL }]);
    await Dataset.exportToJSON('output.json');
})();