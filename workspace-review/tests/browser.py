from playwright.sync_api import sync_playwright
from pathlib import Path
import sys
url=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:4860/index.html'
with sync_playwright() as p:
    b=p.chromium.launch(executable_path=__import__('os').environ.get('CHROMIUM','/usr/bin/chromium'),args=['--no-sandbox'])
    page=b.new_page(viewport={'width':1350,'height':900})
    errors=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(url)
    assert page.locator('#result').inner_text()=='Refund $699', (page.locator('#result').inner_text(),errors)
    page.locator('[data-line="16"]').focus()
    assert 'Line 16' in page.locator('#detail').inner_text()
    page.locator('#mode').select_option('Visual')
    assert '$2,801' in page.locator('#detail').inner_text()
    page.locator('summary').click()
    fixture=Path(__file__).resolve().parents[1]/'samples/HA-Sample-W2-2025.pdf'
    page.locator('#upload').set_input_files(fixture)
    page.locator('#apply').wait_for(timeout=8000)
    page.locator('#apply').click()
    assert page.locator('#result').inner_text()=='Refund $699'
    page.locator('#upload').set_input_files(fixture)
    page.wait_for_function("document.querySelector('#pending').textContent.includes('already')")
    page.reload()
    assert 'confirmed PDF value' in page.locator('#slips').inner_text()
    page.locator('#add').click()
    assert page.locator('#print').is_disabled()
    page.locator('[data-box=wages]').last.fill('0')
    page.locator('[data-box=withheld]').last.fill('100')
    assert page.locator('#result').inner_text()=='Refund $799'
    answers=iter(['0','Transcription check against corrected sample'])
    page.on('dialog',lambda d:d.accept(next(answers)))
    page.get_by_role('button',name='Correct withholding').click()
    assert 'Transcription check against corrected sample' in page.locator('#slips').text_content()
    assert page.locator('#result').inner_text()=='Balance due $2,701'
    page.locator('#year').select_option('2024')
    page.locator('[data-box=wages]').first.fill('39900')
    assert page.locator('#print').is_disabled()
    page.locator('[data-box=wages]').first.fill('40000')
    assert not page.locator('#print').is_disabled()
    page.locator('#confirm').uncheck()
    assert page.locator('#print').is_disabled()
    page.locator('#confirm').check()
    page.locator('#year').select_option('2026')
    assert page.locator('#print').is_disabled() and page.locator('.paper').count()==0
    page.locator('#year').select_option('2025')
    page.set_viewport_size({'width':390,'height':844})
    page.locator('[data-panel=forms]').click()
    page.locator('#line').select_option('25a')
    page.locator('[data-panel=explain]').click()
    assert 'Line 25a' in page.locator('#detail').inner_text()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.emulate_media(media='print')
    pdf=page.pdf(prefer_css_page_size=True,print_background=True)
    import fitz
    doc=fitz.open(stream=pdf,filetype='pdf')
    assert len(doc)==2,len(doc)
    assert all('SYNTHETIC REVIEW COPY' in pg.get_text() for pg in doc)
    page.emulate_media(media='screen')
    if url.startswith('http'):
        page.evaluate('navigator.serviceWorker.ready')
        page.reload()
        page.wait_for_function('!!navigator.serviceWorker.controller')
        page.context.set_offline(True)
        page.reload()
        assert 'Balance due' in page.locator('#result').text_content()
        page.context.set_offline(False)
    assert not errors,errors
    b.close()
print('Browser checks passed: form links, missing and zero, two W-2s, year gates, phone tabs, two-page print.')
