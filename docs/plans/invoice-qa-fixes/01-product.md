# Gate 1 — Product: trustworthy invoice approval

## Problem

"I approved the invoice and it said everything was fine, but none of my costs
changed." An owner has no way to see that, and no way to fix it: the screen
doesn't ask how many bottles are in a case, so a case price can't become a bottle
cost.

"I matched these items last week. Why am I matching them all again?" The app
forgets the work unless the supplier prints item codes in their own column, and
real suppliers often don't.

"I uploaded the same invoice twice by accident." Nothing stops it, and approving
both would record the same costs twice.

## Success metric

**On a real invoice approved through the screen, the number of lines the screen
says posted equals the number of new cost records, and every other line is listed
with a reason.** Measured on the real text invoice, target: 0 unexplained lines.
Second measure: on a later real invoice from the same vendor, every item matched
the first time comes back already matched.

## Announcement

Approving an invoice now tells you exactly what it did. Before you approve, you
see how many lines will update a cost and why any won't, and you can fix most of
them right there by entering the case size, which Truestock remembers for that
supplier's item. After you approve, you see what posted and what didn't. Items you
match once stay matched for that supplier, whether or not the invoice prints item
codes. And if you upload a file you've already uploaded, Truestock stops you and
shows you the original.

## Screens

- `mockups/review-before-approval.html` — the review screen: case size entry, and
  what will post before you approve
- `mockups/approved-result.html` — the result after approving: posted and skipped
- `mockups/duplicate-refused.html` — the upload screen refusing a file it already has
