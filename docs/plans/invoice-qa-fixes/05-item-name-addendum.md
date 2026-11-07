# Addendum: read item code, case pack and bottle size from `Item Name`

Requested by the owner on 2026-11-07, after Gate 4, so it was not part of the
approved slices. It is written down here rather than folded silently into one.
It runs after slice 8 and before slice 9, so the real-invoice proof covers it.

## What changes

Southern Glazer's prints no item code or pack column. Both sit inside the
`Item Name` cell, for example (fabricated):

    SAMPLE VODKA 80 111111 • 1.0L • 12 Case • SCREW CAP

A pure function reads three things from that shape:

| Read | Stored in | Rule |
|---|---|---|
| Item code | `vendorItemCode` | Last token of the first segment, all digits: 5 or more, or exactly 4 straight after a 2-3 digit proof (`80 1234`). A proof such as `80` is never a code, and neither is a lone 4-digit number such as a vintage. |
| Case pack | `packSize` | A whole segment reading `<n> Case`. |
| Bottle size | `packDescription` as `12/1.0L` | A whole segment naming a volume in ml or litres. |

## Rules

- **Only with bullet segments.** A cell with no `•` is left alone. The closure
  segment is optional, because some real lines omit it.
- **A real column always wins.** The reader only fills fields that are still
  null.
- **`description` stays verbatim.** It remains the full printed string, so
  `desc:` alias keys and the size warning do not change.
- **No schema change.** `pack_description` already holds `12/750ML`.
- **The reviewer still confirms.** The pack size appears prefilled in the same
  input as before and can be changed. `product.case_size` is not used.
- **`each` and `keg` lines stay pack 1** through `effectivePackSize`. The pack
  read from their name is remembered on the alias but does not touch their cost.

## Alias keys

A line that gains an item code now keys on that code. Aliases already learned
under a `desc:` key would stop matching, so `matchLinesToProducts` looks up the
code first and falls back to the line's description key. Approving such a line
learns the code key; the old row stays as history.

## Done when

- A synthetic fixture test covers each rule, with a mutation check.
- `docs/vendor-templates/southern-glazers.md` §3 and §4 say what the code does.
- A real invoice goes through the UI and the database shows the code, the pack
  and the size, and a remembered `desc:` alias still matches.
