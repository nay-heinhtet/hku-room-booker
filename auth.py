"""
HKU Library authentication via the HKUL Authentication portal.

Login flow (re-probed 2026-10-18):
  booking.lib.hku.hk → lib.hku.hk/hkulauth/legacy/authMain?uri=...
  The page now first offers two buttons:
    - "HKU Portal Login" → hkuportal.hku.hk/cas/aad (Microsoft sign-in, may
      require MFA, so it can't be automated)
    - "Other Library Users" (#login-library) → reveals the classic form
  Form fields: name='userid' (UID / library card number), name='password' (PIN)
  Submit:      input[name='submit']
  A rejected login reloads the page with #error visible.
"""

import re
import logging
from playwright.async_api import Page, TimeoutError as PWTimeout

from config import BOOKING_BASE_URL, HKU_UID, HKU_PIN

log = logging.getLogger(__name__)

BOOKING_URL = re.compile(r"booking\.lib\.hku\.hk")


class LoginRejected(Exception):
    """HKU refused the UID/PIN. Retrying won't help."""


async def login(page: Page) -> None:
    """Navigate to the booking site and authenticate via the HKUL auth portal."""
    if not HKU_UID or not HKU_PIN:
        raise LoginRejected("HKU_UID and HKU_PIN must be set in the environment or .env")

    log.info(f"Opening {BOOKING_BASE_URL}")
    await page.goto(BOOKING_BASE_URL, wait_until="commit", timeout=30_000)

    # booking.lib.hku.hk redirects to lib.hku.hk/hkulauth/legacy/authMain?uri=...
    await page.wait_for_url(
        re.compile(r"lib\.hku\.hk/hkulauth", re.IGNORECASE),
        timeout=15_000,
    )
    log.info(f"Reached login page: {page.url}")

    # The form stays hidden until the page's script has loaded the SSO params.
    await page.wait_for_selector("#hkulauth", state="visible", timeout=20_000)

    userid = page.locator("input[name='userid']")
    library_login = page.locator("#login-library")
    if not await userid.is_visible() and await library_login.is_visible():
        log.info("Choosing UID/PIN login ('Other Library Users').")
        await library_login.click()
    await userid.wait_for(state="visible", timeout=10_000)

    await userid.fill(HKU_UID)
    await page.fill("input[name='password']", HKU_PIN)
    await page.click("input[name='submit']")

    # Wait until redirected back to the booking system
    try:
        await page.wait_for_url(BOOKING_URL, timeout=25_000)
    except PWTimeout:
        if await page.locator("#error").is_visible():
            raise LoginRejected(
                "HKU rejected the UID/PIN on the library login form. "
                "Check the saved HKU_UID (without @connect.hku.hk) and HKU_PIN."
            ) from None
        raise
    await page.wait_for_load_state("domcontentloaded", timeout=20_000)
    log.info("Login successful — back on booking site.")
