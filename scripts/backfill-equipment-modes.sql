-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill: normalize load_fact.equipment_type and freight_opportunities.equipment_type
-- to the canonical Mode labels used by the Available Loads tab and carrier ranker.
--
-- Canonical labels: Van, Reefer, Power Only, Flatbed, Flatbed w/ Tarps,
-- Step Deck, Double Drop, Conestoga, LTL.
--
-- Safe to re-run: every UPDATE is idempotent (matches the un-normalized variants
-- only). Run inside a transaction so a typo doesn't half-apply.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Helper expression: pull the trimmed/UPPER value once.
WITH ranked AS (
  SELECT id, UPPER(TRIM(equipment_type)) AS code FROM load_fact WHERE equipment_type IS NOT NULL
)
UPDATE load_fact lf SET equipment_type = CASE r.code
    WHEN 'V' THEN 'Van' WHEN 'VAN' THEN 'Van' WHEN 'DV' THEN 'Van' WHEN 'FTL' THEN 'Van'
    WHEN 'R' THEN 'Reefer' WHEN 'RF' THEN 'Reefer' WHEN 'REF' THEN 'Reefer' WHEN 'REEFER' THEN 'Reefer'
    WHEN 'PO' THEN 'Power Only'
    WHEN 'F' THEN 'Flatbed' WHEN 'FB' THEN 'Flatbed' WHEN 'FV' THEN 'Flatbed' WHEN 'FLAT' THEN 'Flatbed' WHEN 'FLATBED' THEN 'Flatbed'
    WHEN 'FT' THEN 'Flatbed w/ Tarps'
    WHEN 'SD' THEN 'Step Deck' WHEN 'SB' THEN 'Step Deck'
    WHEN 'DD' THEN 'Double Drop'
    WHEN 'CN' THEN 'Conestoga' WHEN 'CONESTOGA' THEN 'Conestoga'
    WHEN 'LTL' THEN 'LTL'
  END
FROM ranked r
WHERE lf.id = r.id
  AND r.code IN ('V','VAN','DV','FTL','R','RF','REF','REEFER','PO','F','FB','FV','FLAT','FLATBED','FT','SD','SB','DD','CN','CONESTOGA','LTL')
  AND lf.equipment_type <> CASE r.code
    WHEN 'V' THEN 'Van' WHEN 'VAN' THEN 'Van' WHEN 'DV' THEN 'Van' WHEN 'FTL' THEN 'Van'
    WHEN 'R' THEN 'Reefer' WHEN 'RF' THEN 'Reefer' WHEN 'REF' THEN 'Reefer' WHEN 'REEFER' THEN 'Reefer'
    WHEN 'PO' THEN 'Power Only'
    WHEN 'F' THEN 'Flatbed' WHEN 'FB' THEN 'Flatbed' WHEN 'FV' THEN 'Flatbed' WHEN 'FLAT' THEN 'Flatbed' WHEN 'FLATBED' THEN 'Flatbed'
    WHEN 'FT' THEN 'Flatbed w/ Tarps'
    WHEN 'SD' THEN 'Step Deck' WHEN 'SB' THEN 'Step Deck'
    WHEN 'DD' THEN 'Double Drop'
    WHEN 'CN' THEN 'Conestoga' WHEN 'CONESTOGA' THEN 'Conestoga'
    WHEN 'LTL' THEN 'LTL'
  END;

-- Same normalization for freight_opportunities (so detail page + ranker agree).
WITH ranked AS (
  SELECT id, UPPER(TRIM(equipment_type)) AS code FROM freight_opportunities WHERE equipment_type IS NOT NULL
)
UPDATE freight_opportunities fo SET equipment_type = CASE r.code
    WHEN 'V' THEN 'Van' WHEN 'VAN' THEN 'Van' WHEN 'DV' THEN 'Van' WHEN 'FTL' THEN 'Van'
    WHEN 'R' THEN 'Reefer' WHEN 'RF' THEN 'Reefer' WHEN 'REF' THEN 'Reefer' WHEN 'REEFER' THEN 'Reefer'
    WHEN 'PO' THEN 'Power Only'
    WHEN 'F' THEN 'Flatbed' WHEN 'FB' THEN 'Flatbed' WHEN 'FV' THEN 'Flatbed' WHEN 'FLAT' THEN 'Flatbed' WHEN 'FLATBED' THEN 'Flatbed'
    WHEN 'FT' THEN 'Flatbed w/ Tarps'
    WHEN 'SD' THEN 'Step Deck' WHEN 'SB' THEN 'Step Deck'
    WHEN 'DD' THEN 'Double Drop'
    WHEN 'CN' THEN 'Conestoga' WHEN 'CONESTOGA' THEN 'Conestoga'
    WHEN 'LTL' THEN 'LTL'
  END
FROM ranked r
WHERE fo.id = r.id
  AND r.code IN ('V','VAN','DV','FTL','R','RF','REF','REEFER','PO','F','FB','FV','FLAT','FLATBED','FT','SD','SB','DD','CN','CONESTOGA','LTL')
  AND fo.equipment_type <> CASE r.code
    WHEN 'V' THEN 'Van' WHEN 'VAN' THEN 'Van' WHEN 'DV' THEN 'Van' WHEN 'FTL' THEN 'Van'
    WHEN 'R' THEN 'Reefer' WHEN 'RF' THEN 'Reefer' WHEN 'REF' THEN 'Reefer' WHEN 'REEFER' THEN 'Reefer'
    WHEN 'PO' THEN 'Power Only'
    WHEN 'F' THEN 'Flatbed' WHEN 'FB' THEN 'Flatbed' WHEN 'FV' THEN 'Flatbed' WHEN 'FLAT' THEN 'Flatbed' WHEN 'FLATBED' THEN 'Flatbed'
    WHEN 'FT' THEN 'Flatbed w/ Tarps'
    WHEN 'SD' THEN 'Step Deck' WHEN 'SB' THEN 'Step Deck'
    WHEN 'DD' THEN 'Double Drop'
    WHEN 'CN' THEN 'Conestoga' WHEN 'CONESTOGA' THEN 'Conestoga'
    WHEN 'LTL' THEN 'LTL'
  END;

-- Backfill load_fact.account_manager from freight_opportunities owner email
-- (raw Ops user handle persisted in the audit payload of the "generated" event).
-- Only updates rows where account_manager is currently NULL.
UPDATE load_fact lf
SET account_manager = sub.owner_email
FROM (
  SELECT
    'freight_opp:' || fo.id AS order_id,
    (
      SELECT (a.payload->>'ownerEmail')
      FROM freight_opportunity_audit a
      WHERE a.opportunity_id = fo.id
        AND a.event_type = 'generated'
        AND a.payload ? 'ownerEmail'
      ORDER BY a.created_at ASC
      LIMIT 1
    ) AS owner_email
  FROM freight_opportunities fo
) sub
WHERE lf.order_id = sub.order_id
  AND lf.account_manager IS NULL
  AND sub.owner_email IS NOT NULL;

COMMIT;

-- Verify
SELECT equipment_type, COUNT(*) FROM load_fact GROUP BY equipment_type ORDER BY 2 DESC;
SELECT account_manager, COUNT(*) FROM load_fact WHERE bucket IN ('available','unknown') GROUP BY account_manager ORDER BY 2 DESC LIMIT 20;
