# PARITY TEST MATRIX (`PARITY_TEST_MATRIX.md`)
**Project**: SIGAP Inventory System Migration  
**Target Architecture**: Firebase Application Architecture

---

## Behavioral Parity Test Results

| Test ID | Scenario Description | Apps Script Behavior | Firebase Behavior | Parity Result | Verification Status |
| :--- | :--- | :--- | :--- | :---: | :---: |
| **AUTH-01** | Login valid Admin user | Token returned, full navigation menu visible | Token returned, full navigation menu visible | `SAME` | **PASS** |
| **AUTH-02** | Login valid Manager user | Token returned, operational tabs visible, `tab-users` hidden | Token returned, operational tabs visible, `tab-users` hidden | `SAME` | **PASS** |
| **AUTH-03** | Login valid Stock Keeper user | Token returned, operational subset visible (`Dashboard`, `Keluar`, `Riwayat`, `Masuk`, `Stock`, `Exp`) | Token returned, operational subset visible (`Dashboard`, `Keluar`, `Riwayat`, `Masuk`, `Stock`, `Exp`) | `SAME` | **PASS** |
| **AUTH-04** | Login NONAKTIF user | Blocked with "Akun Anda NONAKTIF. Hubungi Administrator." | Blocked with "Akun Anda NONAKTIF. Hubungi Administrator." | `SAME` | **PASS** |
| **AUTH-05** | Login incorrect password | Blocked with "Username atau password salah." | Blocked with "Username atau password salah." | `SAME` | **PASS** |
| **SEC-01** | Manager direct API access to `listUsers` | Rejected by `requireRole_` guard | Blocked by `firestore.rules` & function guard | `SAME` | **PASS** |
| **SEC-02** | Stock Keeper direct API access to `saveOpnameData` | Rejected by `requireRole_` guard | Blocked by `firestore.rules` & function guard | `SAME` | **PASS** |
| **SEC-03** | Stock Keeper direct API access to `addMasterItem` | Rejected by `requireRole_` guard | Blocked by `firestore.rules` & function guard | `SAME` | **PASS** |
| **IN-01** | Ingest Inbound entry with Batch Number | Written to `IN` sheet, column L filled | Written to `inbound` collection document | `SAME` | **PASS** |
| **IN-02** | Ingest Inbound with `NO PGR` | Treated as `STOCK AWAL` in Stock Card ledger | Treated as `stockAwal` in Stock Card ledger calculation | `SAME` | **PASS** |
| **OUT-01** | Ingest Outbound entry with Auto SPB | Generated `SPB-DDMMYY-XXX` sequence | Generated `SPB-DDMMYY-XXX` sequence | `SAME` | **PASS** |
| **OUT-02** | Ingest Outbound entry with Remarks (Keterangan) | Written to `OUT` sheet, column L filled | Written to `outbound` collection document | `SAME` | **PASS** |
| **STK-01** | Stock Card calculation | `Stock Awal + IN - OUT + ADJ` | `Stock Awal + IN - OUT + ADJ` | `SAME` | **PASS** |
| **OPN-01** | Stock Opname with Selisih > 0 | Status `ADJ MASUK` (+Qty adjustment) | Status `ADJ MASUK` (+Qty adjustment) | `SAME` | **PASS** |
| **OPN-02** | Stock Opname with Selisih < 0 | Status `ADJ KELUAR` (-Qty adjustment) | Status `ADJ KELUAR` (-Qty adjustment) | `SAME` | **PASS** |
| **OPN-03** | Stock Opname with Selisih = 0 | Status `SESUAI` (No adjustment record written) | Status `SESUAI` (No adjustment record written) | `SAME` | **PASS** |
| **EXP-01** | Expiry status remaining days calculation | Diff days relative to Asia/Jakarta GMT+7 midnight | Diff days relative to Asia/Jakarta GMT+7 midnight | `SAME` | **PASS** |
| **RCP-01** | Recipe Duplicate Check (Item + Product) | Blocked with "Resep sudah ada." | Blocked with "Resep sudah ada." | `SAME` | **PASS** |
| **CNV-01** | Conversion Duplicate Check (Item + UOM) | Blocked with "Konversi sudah ada." | Blocked with "Konversi sudah ada." | `SAME` | **PASS** |
| **SCN-01** | Scanner payload `SIGAP:RAK:R-03;ITEM:GR-001` | Context extracted: Item `GR-001`, Rack `R-03` | Context extracted: Item `GR-001`, Rack `R-03` | `SAME` | **PASS** |
| **IMG-01** | SKU Image Upload | Image uploaded to Drive, reference saved | Image uploaded to Cloud Storage, download URL saved | `SAME` | **PASS** |

---
**Final Parity Audit Conclusion**: ALL 21 PARITY SCENARIOS PASSED WITH 100% BEHAVIORAL EQUIVALENCY.
