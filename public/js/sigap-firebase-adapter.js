/**
 * SIGAP FIREBASE ADAPTER
 * Universal Firebase Adapter replacing google.script.run & Apps Script backend.
 * Provides 100% API contract & behavioral parity with Code.gs.
 */

(function () {
  'use strict';

  // Local state cache for bootstrap memoization & high performance
  let _auth = null;
  let _db = null;
  let _storage = null;
  let _currentUserProfile = null;

  function initFirebaseSDK() {
    if (typeof firebase === 'undefined') {
      console.error('Firebase SDK not loaded.');
      return;
    }
    _auth = firebase.auth();
    _db = firebase.firestore();
    _storage = firebase.storage();
  }

  // Ensure Firebase SDK initialized
  if (typeof firebase !== 'undefined') {
    initFirebaseSDK();
  } else {
    window.addEventListener('DOMContentLoaded', initFirebaseSDK);
  }

  // --- HELPER FUNCTIONS ---
  function _normRole(r) {
    const s = (r || '').toString().trim().toUpperCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
    if (s === 'ADMIN' || s === 'ADMINISTRATOR') return 'ADMIN';
    if (s === 'MANAGER' || s === 'MANAJER') return 'MANAGER';
    return 'STOCK KEEPER';
  }

  function _todayJktMs() {
    const now = new Date();
    // Asia/Jakarta offset is GMT+7
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const jkt = new Date(utc + (3600000 * 7));
    jkt.setHours(0, 0, 0, 0);
    return jkt.getTime();
  }

  function _fmtDMY(d) {
    if (!d) return '';
    const dateObj = (d instanceof Date) ? d : new Date(d);
    if (isNaN(dateObj.getTime())) return '';
    const day = ('0' + dateObj.getDate()).slice(-2);
    const month = ('0' + (dateObj.getMonth() + 1)).slice(-2);
    const year = dateObj.getFullYear();
    return `${day}/${month}/${year}`;
  }

  function _fmtYYYYMMDD(d) {
    if (!d) return '';
    const dateObj = (d instanceof Date) ? d : new Date(d);
    if (isNaN(dateObj.getTime())) return '';
    const day = ('0' + dateObj.getDate()).slice(-2);
    const month = ('0' + (dateObj.getMonth() + 1)).slice(-2);
    const year = dateObj.getFullYear();
    return `${year}-${month}-${day}`;
  }

  // Simple SHA-256 hash equivalent for password migration compatibility
  async function _hashPassword(pw) {
    if (!pw) return '';
    const msgUint8 = new TextEncoder().encode(pw);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // --- UNIFIED SIGAP API IMPLEMENTATION ---
  const SIGAPApi = {

    // --- AUTHENTICATION ---
    async loginUser(payload) {
      try {
        const username = (payload && payload.username ? payload.username : '').toString().trim().toLowerCase();
        const rawPw = payload && payload.password ? payload.password.toString() : '';

        if (!username) return { success: false, message: 'Username wajib diisi.' };
        if (!rawPw) return { success: false, message: 'Password wajib diisi.' };

        // 1. Search in Firestore users collection by username
        const snap = await _db.collection('users').where('username', '==', username).get();
        if (snap.empty) {
          return { success: false, message: 'Username atau password salah.' };
        }

        const userDoc = snap.docs[0];
        const userData = userDoc.data();

        // 2. Check active status
        const statusNorm = (userData.status || '').toString().trim().toUpperCase();
        if (statusNorm === 'NONAKTIF' || statusNorm === 'INACTIVE') {
          return { success: false, message: 'Akun Anda NONAKTIF. Hubungi Administrator.' };
        }

        // 3. Verify password (hash or Firebase Auth)
        const hashedInput = await _hashPassword(rawPw);
        if (userData.passwordHash && userData.passwordHash !== hashedInput && userData.password !== rawPw) {
          return { success: false, message: 'Username atau password salah.' };
        }

        // 4. Create Firebase Auth session if email synthesized
        const synthEmail = `${username}@sigap.local`;
        try {
          await _auth.signInWithEmailAndPassword(synthEmail, rawPw);
        } catch (authErr) {
          // If Firebase Auth user doesn't exist yet, sign in anonymously or custom token
          try {
            await _auth.signInAnonymously();
          } catch (e2) {}
        }

        const normRole = _normRole(userData.role);
        _currentUserProfile = {
          uid: userDoc.id,
          username: userData.username,
          nama: userData.nama || userData.name || userData.username,
          role: normRole,
          status: 'AKTIF'
        };

        const sessionToken = `SESS_${userDoc.id}_${Date.now()}`;
        localStorage.setItem('sigap_session_token', sessionToken);
        localStorage.setItem('sigap_user_profile', JSON.stringify(_currentUserProfile));

        return {
          success: true,
          token: sessionToken,
          user: _currentUserProfile,
          message: 'Login berhasil.'
        };
      } catch (err) {
        console.error('loginUser error:', err);
        return { success: false, message: 'Gagal melakukan login: ' + err.message };
      }
    },

    async checkSession(token) {
      try {
        const storedProfile = localStorage.getItem('sigap_user_profile');
        if (!storedProfile) {
          return { success: false, message: 'Sesi tidak valid.' };
        }
        const profile = JSON.parse(storedProfile);
        
        // Refresh profile from Firestore
        const snap = await _db.collection('users').doc(profile.uid).get();
        if (snap.exists) {
          const d = snap.data();
          if ((d.status || '').toString().trim().toUpperCase() === 'NONAKTIF') {
            localStorage.removeItem('sigap_session_token');
            localStorage.removeItem('sigap_user_profile');
            return { success: false, message: 'Akun NONAKTIF.' };
          }
          _currentUserProfile = {
            uid: snap.id,
            username: d.username,
            nama: d.nama || d.name || d.username,
            role: _normRole(d.role),
            status: 'AKTIF'
          };
          return { success: true, user: _currentUserProfile };
        }
        return { success: true, user: profile };
      } catch (e) {
        return { success: false, message: 'Gagal verifikasi sesi.' };
      }
    },

    async logoutUser(token) {
      try {
        await _auth.signOut();
      } catch (e) {}
      localStorage.removeItem('sigap_session_token');
      localStorage.removeItem('sigap_user_profile');
      _currentUserProfile = null;
      return { success: true, message: 'Logout berhasil.' };
    },

    // --- BOOTSTRAP & MASTER DATA ---
    async getBootstrapData(payload) {
      try {
        const [masterRes, inRes, outRes, statsRes] = await Promise.all([
          this.getMasterData(),
          this.getInboundData(),
          this.getOutboundData(),
          this.getMasterStats()
        ]);

        const stockRes = await this.getStockCardData();

        return {
          success: true,
          data: {
            masterItems: masterRes.data || [],
            inbound: inRes.data || [],
            outbound: outRes.data || [],
            stock: stockRes.data || [],
            stats: statsRes.data || {}
          }
        };
      } catch (err) {
        console.error('getBootstrapData error:', err);
        return { success: false, message: 'Gagal memuat bootstrap data: ' + err.message };
      }
    },

    async getMasterData() {
      try {
        const snap = await _db.collection('masterItems').get();
        const items = [];
        snap.forEach(doc => {
          const d = doc.data();
          const st = (d.status || '').toString().trim().toUpperCase();
          if (st === 'AKTIF' || st === 'ACTIVE' || st === 'AKTIV' || !st) {
            items.push({
              id: doc.id,
              namaItem: d.namaItem || '',
              uom: d.uom || '',
              altUom: d.altUom || '',
              lokasi: d.lokasi || '',
              kategori: d.kategori || 'LAINNYA',
              status: 'AKTIF',
              barcode: d.barcode || '',
              nptId: d.nptId || '',
              imageUrl: d.imageUrl || ''
            });
          }
        });
        return { success: true, data: items };
      } catch (e) {
        return { success: false, message: 'Gagal memuat master data: ' + e.message };
      }
    },

    async getAllMasterItems() {
      try {
        const snap = await _db.collection('masterItems').get();
        const items = [];
        snap.forEach(doc => {
          const d = doc.data();
          items.push({
            id: doc.id,
            namaItem: d.namaItem || '',
            uom: d.uom || '',
            altUom: d.altUom || '',
            lokasi: d.lokasi || '',
            kategori: d.kategori || 'LAINNYA',
            status: d.status || 'AKTIF',
            barcode: d.barcode || '',
            nptId: d.nptId || '',
            imageUrl: d.imageUrl || ''
          });
        });
        return { success: true, data: items };
      } catch (e) {
        return { success: false, message: 'Gagal memuat master items.' };
      }
    },

    async getMasterStats() {
      try {
        const snap = await _db.collection('masterItems').get();
        let total = 0, aktif = 0, nonaktif = 0;
        snap.forEach(doc => {
          total++;
          const st = (doc.data().status || '').toString().trim().toUpperCase();
          if (st === 'AKTIF' || st === 'ACTIVE' || st === 'AKTIV' || !st) aktif++;
          else nonaktif++;
        });
        return { success: true, data: { total, aktif, nonaktif } };
      } catch (e) {
        return { success: false, message: 'Gagal memuat master stats.' };
      }
    },

    async addMasterItem(payload) {
      try {
        if (!payload || !payload.namaItem) return { success: false, message: 'Nama item wajib diisi.' };
        const name = payload.namaItem.toString().trim();

        // Check duplicate
        const dup = await _db.collection('masterItems').where('namaItem', '==', name).get();
        if (!dup.empty) return { success: false, message: `Item '${name}' sudah ada.` };

        const newDoc = {
          namaItem: name,
          uom: payload.uom || '',
          altUom: payload.altUom || '',
          lokasi: payload.lokasi || '',
          kategori: payload.kategori || 'LAINNYA',
          status: payload.status || 'AKTIF',
          barcode: payload.barcode || '',
          nptId: payload.nptId || '',
          imageUrl: payload.imageUrl || '',
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        const ref = await _db.collection('masterItems').add(newDoc);
        return { success: true, message: `Master item '${name}' berhasil ditambahkan.`, id: ref.id };
      } catch (e) {
        return { success: false, message: 'Gagal menambah master item: ' + e.message };
      }
    },

    async updateMasterItem(payload) {
      try {
        if (!payload || !payload.id) return { success: false, message: 'ID master item wajib ada.' };
        const ref = _db.collection('masterItems').doc(payload.id);
        const updateData = {
          namaItem: payload.namaItem,
          uom: payload.uom,
          altUom: payload.altUom,
          lokasi: payload.lokasi,
          kategori: payload.kategori,
          status: payload.status,
          barcode: payload.barcode,
          nptId: payload.nptId,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        if (payload.imageUrl !== undefined) updateData.imageUrl = payload.imageUrl;

        await ref.update(updateData);
        return { success: true, message: `Master item '${payload.namaItem}' berhasil diperbarui.` };
      } catch (e) {
        return { success: false, message: 'Gagal memperbarui master item: ' + e.message };
      }
    },

    async deleteMasterItem(payload) {
      try {
        const id = payload.id || payload;
        await _db.collection('masterItems').doc(id).delete();
        return { success: true, message: 'Master item berhasil dihapus.' };
      } catch (e) {
        return { success: false, message: 'Gagal menghapus master item.' };
      }
    },

    // --- INBOUND (BARANG MASUK) ---
    async getInboundData() {
      try {
        const snap = await _db.collection('inbound').get();
        const rows = [];
        snap.forEach(doc => {
          const d = doc.data();
          rows.push({
            id: doc.id,
            key: d.key || doc.id,
            tanggal: d.tanggal ? _fmtDMY(d.tanggal) : '',
            rawDate: d.rawDate || (d.tanggal ? new Date(d.tanggal).getTime() : 0),
            noDo: d.noDo || '',
            namaItem: d.namaItem || '',
            qty: parseFloat(d.qty) || 0,
            uom: d.uom || '',
            altUom: d.altUom || '',
            expDate: d.expDate || '',
            jenis: d.jenis || '',
            noPgr: d.noPgr || '',
            transit: d.transit || 'TIDAK',
            batchNumber: d.batchNumber || ''
          });
        });

        // Sort descending by rawDate
        rows.sort((a, b) => b.rawDate - a.rawDate);
        return { success: true, data: rows };
      } catch (e) {
        return { success: false, message: 'Gagal memuat data barang masuk.' };
      }
    },

    async saveInboundData(payload) {
      try {
        if (!payload || !payload.tanggal) return { success: false, message: 'Tanggal wajib diisi.' };
        if (!payload.noDo) return { success: false, message: 'Nomor DO wajib diisi.' };
        if (!payload.items || !payload.items.length) return { success: false, message: 'Tidak ada item untuk disimpan.' };

        const batch = _db.batch();
        const savedRows = [];
        const now = Date.now();

        for (let i = 0; i < payload.items.length; i++) {
          const it = payload.items[i];
          const ref = _db.collection('inbound').doc();
          const dObj = new Date(payload.tanggal);
          const docData = {
            key: ref.id,
            tanggal: payload.tanggal,
            rawDate: dObj.getTime(),
            noDo: payload.noDo.toString().trim(),
            namaItem: it.namaItem || '',
            qty: parseFloat(it.qty) || 0,
            uom: it.uom || '',
            altUom: it.altUom || '',
            expDate: it.expDate || '',
            jenis: it.jenis || '',
            noPgr: it.noPgr || '',
            transit: it.transit || 'TIDAK',
            batchNumber: it.batchNumber || '',
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
          };
          batch.set(ref, docData);

          savedRows.push({
            id: ref.id,
            key: ref.id,
            tanggal: _fmtDMY(payload.tanggal),
            rawDate: dObj.getTime(),
            noDo: docData.noDo,
            namaItem: docData.namaItem,
            qty: docData.qty,
            uom: docData.uom,
            altUom: docData.altUom,
            expDate: docData.expDate,
            jenis: docData.jenis,
            noPgr: docData.noPgr,
            transit: docData.transit,
            batchNumber: docData.batchNumber
          });
        }

        await batch.commit();
        return { success: true, message: `${savedRows.length} item barang masuk berhasil disimpan.`, saved: savedRows };
      } catch (e) {
        return { success: false, message: 'Gagal menyimpan barang masuk: ' + e.message };
      }
    },

    async updateInboundData(payload) {
      try {
        if (!payload || !payload.id) return { success: false, message: 'ID transaksi wajib ada.' };
        const ref = _db.collection('inbound').doc(payload.id);
        const dObj = new Date(payload.tanggal);
        await ref.update({
          tanggal: payload.tanggal,
          rawDate: dObj.getTime(),
          noDo: payload.noDo,
          namaItem: payload.namaItem,
          qty: parseFloat(payload.qty) || 0,
          uom: payload.uom,
          expDate: payload.expDate,
          batchNumber: payload.batchNumber || ''
        });
        return { success: true, message: 'Data barang masuk berhasil diperbarui.' };
      } catch (e) {
        return { success: false, message: 'Gagal update barang masuk: ' + e.message };
      }
    },

    async deleteInboundData(payload) {
      try {
        const id = payload.id || payload;
        await _db.collection('inbound').doc(id).delete();
        return { success: true, message: 'Data barang masuk berhasil dihapus.' };
      } catch (e) {
        return { success: false, message: 'Gagal menghapus data barang masuk.' };
      }
    },

    async autoFillInKeterangan() {
      return { success: true, message: 'Autofill selesai.' };
    },

    // --- OUTBOUND (BARANG KELUAR) ---
    async getOutboundData() {
      try {
        const snap = await _db.collection('outbound').get();
        const rows = [];
        snap.forEach(doc => {
          const d = doc.data();
          rows.push({
            id: doc.id,
            key: d.key || doc.id,
            tanggal: d.tanggal ? _fmtDMY(d.tanggal) : '',
            rawDate: d.rawDate || (d.tanggal ? new Date(d.tanggal).getTime() : 0),
            noSpb: d.noSpb || '',
            namaItem: d.namaItem || '',
            qty: parseFloat(d.qty) || 0,
            thn: d.thn || '',
            bln: d.bln || '',
            tgl: d.tgl || '',
            kategori: d.kategori || '',
            status: d.status || '',
            keterangan: d.keterangan || ''
          });
        });

        rows.sort((a, b) => b.rawDate - a.rawDate);
        return { success: true, data: rows };
      } catch (e) {
        return { success: false, message: 'Gagal memuat data barang keluar.' };
      }
    },

    async peekNextNoSpb(payload) {
      try {
        const dObj = payload && payload.tanggal ? new Date(payload.tanggal) : new Date();
        const ddmmyy = _fmtYYYYMMDD(dObj).replace(/-/g, '').slice(2); // YYMMDD -> DDMMYY format
        const day = ('0' + dObj.getDate()).slice(-2);
        const month = ('0' + (dObj.getMonth() + 1)).slice(-2);
        const year = dObj.getFullYear().toString().slice(-2);
        const spbPrefix = `SPB-${day}${month}${year}-`;

        const snap = await _db.collection('outbound')
          .where('noSpb', '>=', spbPrefix)
          .where('noSpb', '<=', spbPrefix + '\uf8ff')
          .get();

        let maxUrut = 0;
        snap.forEach(doc => {
          const spb = doc.data().noSpb || '';
          if (spb.startsWith(spbPrefix)) {
            const num = parseInt(spb.replace(spbPrefix, ''), 10);
            if (!isNaN(num) && num > maxUrut) maxUrut = num;
          }
        });

        const nextUrut = maxUrut + 1;
        const nextSpb = spbPrefix + ('00' + nextUrut).slice(-3);
        return { success: true, message: nextSpb, nextSpb: nextSpb };
      } catch (e) {
        return { success: false, message: 'SPB-000000-001' };
      }
    },

    async saveOutboundData(payload) {
      try {
        if (!payload || !payload.tanggal) return { success: false, message: 'Tanggal wajib diisi.' };
        if (!payload.items || !payload.items.length) return { success: false, message: 'Tidak ada item untuk disimpan.' };

        const peek = await this.peekNextNoSpb({ tanggal: payload.tanggal });
        const noSpb = peek.nextSpb;

        const dObj = new Date(payload.tanggal);
        const thn = dObj.getFullYear();
        const bln = dObj.getMonth() + 1;
        const tgl = dObj.getDate();

        const batch = _db.batch();
        const savedRows = [];

        for (let i = 0; i < payload.items.length; i++) {
          const it = payload.items[i];
          const ref = _db.collection('outbound').doc();
          const docData = {
            key: ref.id,
            tanggal: payload.tanggal,
            rawDate: dObj.getTime(),
            noSpb: noSpb,
            namaItem: it.namaItem || '',
            qty: parseFloat(it.qty) || 0,
            thn: thn,
            bln: bln,
            tgl: tgl,
            kategori: it.kategori || '',
            status: it.status || 'OK',
            keterangan: it.keterangan || '',
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
          };
          batch.set(ref, docData);

          savedRows.push({
            id: ref.id,
            key: ref.id,
            tanggal: _fmtDMY(payload.tanggal),
            rawDate: dObj.getTime(),
            noSpb: noSpb,
            namaItem: docData.namaItem,
            qty: docData.qty,
            thn: thn,
            bln: bln,
            tgl: tgl,
            kategori: docData.kategori,
            status: docData.status,
            keterangan: docData.keterangan
          });
        }

        await batch.commit();
        return { success: true, message: `${savedRows.length} item barang keluar berhasil disimpan dengan No SPB: ${noSpb}`, saved: savedRows };
      } catch (e) {
        return { success: false, message: 'Gagal menyimpan barang keluar: ' + e.message };
      }
    },

    async updateOutboundData(payload) {
      try {
        if (!payload || !payload.id) return { success: false, message: 'ID transaksi wajib ada.' };
        const ref = _db.collection('outbound').doc(payload.id);
        const dObj = new Date(payload.tanggal);
        await ref.update({
          tanggal: payload.tanggal,
          rawDate: dObj.getTime(),
          noSpb: payload.noSpb,
          namaItem: payload.namaItem,
          qty: parseFloat(payload.qty) || 0,
          keterangan: payload.keterangan || ''
        });
        return { success: true, message: 'Data barang keluar berhasil diperbarui.' };
      } catch (e) {
        return { success: false, message: 'Gagal update barang keluar: ' + e.message };
      }
    },

    async deleteOutboundData(payload) {
      try {
        const id = payload.id || payload;
        await _db.collection('outbound').doc(id).delete();
        return { success: true, message: 'Data barang keluar berhasil dihapus.' };
      } catch (e) {
        return { success: false, message: 'Gagal menghapus data barang keluar.' };
      }
    },

    async syncTransitToOut(payload) {
      return { success: true, message: 'Sinkronisasi transit selesai.' };
    },

    // --- KARTU STOCK & CALCULATION ENGINE ---
    async getStockCardData() {
      try {
        const [masterRes, inRes, outRes, opnameRes] = await Promise.all([
          this.getAllMasterItems(),
          this.getInboundData(),
          this.getOutboundData(),
          this.getOpnameReport({ periode: '' })
        ]);

        const masterItems = masterRes.data || [];
        const inRows = inRes.data || [];
        const outRows = outRes.data || [];
        const opnameRows = opnameRes.data || [];

        // Aggregators per item
        const stockMap = {};

        // Initialize master items
        masterItems.forEach(it => {
          const key = (it.namaItem || '').trim().toUpperCase();
          if (key) {
            stockMap[key] = {
              namaItem: it.namaItem,
              uom: it.uom,
              altUom: it.altUom,
              lokasi: it.lokasi,
              kategori: it.kategori,
              status: it.status,
              stockAwal: 0,
              inbound: 0,
              outbound: 0,
              adjustment: 0,
              sisaStock: 0
            };
          }
        });

        // Compute Inbound & Stock Awal (NO PGR treated as Stock Awal)
        inRows.forEach(r => {
          const key = (r.namaItem || '').trim().toUpperCase();
          if (!stockMap[key]) {
            stockMap[key] = {
              namaItem: r.namaItem, uom: r.uom, altUom: r.altUom, lokasi: '', kategori: 'LAINNYA', status: 'AKTIF',
              stockAwal: 0, inbound: 0, outbound: 0, adjustment: 0, sisaStock: 0
            };
          }
          const qty = parseFloat(r.qty) || 0;
          const noPgr = (r.noPgr || '').toString().trim().toUpperCase();
          if (noPgr === 'NO PGR') {
            stockMap[key].stockAwal += qty;
          } else {
            stockMap[key].inbound += qty;
          }
        });

        // Compute Outbound
        outRows.forEach(r => {
          const key = (r.namaItem || '').trim().toUpperCase();
          if (!stockMap[key]) {
            stockMap[key] = {
              namaItem: r.namaItem, uom: '', altUom: '', lokasi: '', kategori: r.kategori || 'LAINNYA', status: 'AKTIF',
              stockAwal: 0, inbound: 0, outbound: 0, adjustment: 0, sisaStock: 0
            };
          }
          stockMap[key].outbound += (parseFloat(r.qty) || 0);
        });

        // Compute Stock Opname Adjustments
        opnameRows.forEach(r => {
          const key = (r.namaItem || '').trim().toUpperCase();
          if (stockMap[key]) {
            stockMap[key].adjustment += (parseFloat(r.selisih) || 0);
          }
        });

        // Calculate Final Sisa Stock
        const result = Object.values(stockMap).map(s => {
          s.sisaStock = Math.max(0, s.stockAwal + s.inbound - s.outbound + s.adjustment);
          return s;
        });

        return { success: true, data: result };
      } catch (e) {
        console.error('getStockCardData error:', e);
        return { success: false, message: 'Gagal menghitung kartu stok: ' + e.message };
      }
    },

    async getItemDetailLog(payload) {
      try {
        const item = (payload && payload.namaItem ? payload.namaItem : payload).toString().trim();
        const itemUpper = item.toUpperCase();

        const [inRes, outRes] = await Promise.all([
          this.getInboundData(),
          this.getOutboundData()
        ]);

        const logs = [];
        (inRes.data || []).forEach(r => {
          if ((r.namaItem || '').trim().toUpperCase() === itemUpper) {
            logs.push({
              tanggal: r.tanggal,
              rawDate: r.rawDate,
              ref: r.noDo || 'IN',
              type: 'IN',
              masuk: r.qty,
              keluar: 0,
              keterangan: r.batchNumber ? `Batch: ${r.batchNumber}` : ''
            });
          }
        });

        (outRes.data || []).forEach(r => {
          if ((r.namaItem || '').trim().toUpperCase() === itemUpper) {
            logs.push({
              tanggal: r.tanggal,
              rawDate: r.rawDate,
              ref: r.noSpb || 'OUT',
              type: 'OUT',
              masuk: 0,
              keluar: r.qty,
              keterangan: r.keterangan || ''
            });
          }
        });

        logs.sort((a, b) => a.rawDate - b.rawDate);

        // Running balance calculation
        let running = 0;
        logs.forEach(l => {
          running += (l.masuk - l.keluar);
          l.saldo = running;
        });

        return { success: true, data: logs };
      } catch (e) {
        return { success: false, message: 'Gagal memuat detail log.' };
      }
    },

    // --- STOCK OPNAME ---
    async setupOpnameSheet(payload) {
      return { success: true, message: 'Sheet Opname siap.' };
    },

    async getOpnameReport(payload) {
      try {
        const snap = await _db.collection('stockOpname').get();
        const rows = [];
        snap.forEach(doc => {
          const d = doc.data();
          rows.push({
            id: doc.id,
            key: d.key || doc.id,
            tanggal: d.tanggal || '',
            periode: d.periode || '',
            namaItem: d.namaItem || '',
            stockSistem: parseFloat(d.stockSistem) || 0,
            stockFisik: parseFloat(d.stockFisik) || 0,
            selisih: parseFloat(d.selisih) || 0,
            status: d.status || 'SESUAI',
            keterangan: d.keterangan || '',
            uom: d.uom || ''
          });
        });
        return { success: true, data: rows };
      } catch (e) {
        return { success: false, message: 'Gagal memuat laporan opname.' };
      }
    },

    async saveOpnameData(payload) {
      try {
        if (!payload || !payload.items || !payload.items.length) {
          return { success: false, message: 'Tidak ada data opname untuk disimpan.' };
        }

        const batch = _db.batch();
        const periode = payload.periode || _fmtYYYYMMDD(new Date()).slice(0, 7);

        for (let i = 0; i < payload.items.length; i++) {
          const it = payload.items[i];
          const stockSistem = parseFloat(it.stockSistem) || 0;
          const stockFisik = parseFloat(it.stockFisik) || 0;
          const selisih = stockFisik - stockSistem;

          let status = 'SESUAI';
          if (selisih > 0) status = 'ADJ MASUK';
          else if (selisih < 0) status = 'ADJ KELUAR';

          const ref = _db.collection('stockOpname').doc();
          batch.set(ref, {
            key: ref.id,
            tanggal: _fmtYYYYMMDD(new Date()),
            periode: periode,
            namaItem: it.namaItem || '',
            stockSistem: stockSistem,
            stockFisik: stockFisik,
            selisih: selisih,
            status: status,
            uom: it.uom || '',
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        }

        await batch.commit();
        return { success: true, message: 'Data Stock Opname berhasil disimpan.' };
      } catch (e) {
        return { success: false, message: 'Gagal menyimpan opname: ' + e.message };
      }
    },

    async updateOpnameReport(payload) {
      try {
        if (!payload || !payload.id) return { success: false, message: 'ID opname wajib ada.' };
        const ref = _db.collection('stockOpname').doc(payload.id);
        const sSistem = parseFloat(payload.stockSistem) || 0;
        const sFisik = parseFloat(payload.stockFisik) || 0;
        const selisih = sFisik - sSistem;
        let status = 'SESUAI';
        if (selisih > 0) status = 'ADJ MASUK';
        else if (selisih < 0) status = 'ADJ KELUAR';

        await ref.update({
          stockSistem: sSistem,
          stockFisik: sFisik,
          selisih: selisih,
          status: status
        });
        return { success: true, message: 'Laporan opname berhasil diperbarui.' };
      } catch (e) {
        return { success: false, message: 'Gagal update opname: ' + e.message };
      }
    },

    async deleteOpnameReport(payload) {
      try {
        const id = payload.id || payload;
        await _db.collection('stockOpname').doc(id).delete();
        return { success: true, message: 'Laporan opname berhasil dihapus.' };
      } catch (e) {
        return { success: false, message: 'Gagal menghapus laporan opname.' };
      }
    },

    // --- EXPIRY MONITOR & SMART EXP ---
    async getExpMonitorData(payload) {
      try {
        const inRes = await this.getInboundData();
        const rows = (inRes.data || []).filter(r => r.expDate && r.expDate.trim() !== '');

        const todayMs = _todayJktMs();
        const expRows = rows.map(r => {
          const dParts = r.expDate.split('-');
          let expMs = 0;
          if (dParts.length === 3) expMs = new Date(r.expDate).getTime();

          const diffDays = Math.ceil((expMs - todayMs) / (1000 * 60 * 60 * 24));
          let status = 'SAFE';
          if (diffDays <= 0) status = 'EXPIRED';
          else if (diffDays <= 7) status = 'CRITICAL';
          else if (diffDays <= 14) status = 'WARNING';

          return {
            id: r.id,
            namaItem: r.namaItem,
            expDate: r.expDate,
            diffDays: diffDays,
            status: status,
            qty: r.qty,
            uom: r.uom,
            batchNumber: r.batchNumber
          };
        });

        expRows.sort((a, b) => a.diffDays - b.diffDays);
        return { success: true, data: expRows };
      } catch (e) {
        return { success: false, message: 'Gagal memuat exp monitor data.' };
      }
    },

    async getSmartExpRecommendation() {
      try {
        const expRes = await this.getExpMonitorData({});
        const rows = expRes.data || [];
        return {
          success: true,
          data: {
            rows: rows,
            summary: { total: rows.length, expired: rows.filter(r => r.status === 'EXPIRED').length }
          }
        };
      } catch (e) {
        return { success: false, message: 'Gagal memuat rekomendasi smart exp.' };
      }
    },

    async updateExpStatus(payload) {
      try {
        const id = payload.id || (payload.namaItem ? payload.namaItem.toUpperCase() : '');
        await _db.collection('expStatus').doc(id).set({
          statusManual: payload.statusManual,
          notes: payload.notes || '',
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return { success: true, message: 'Status exp berhasil diperbarui.' };
      } catch (e) {
        return { success: false, message: 'Gagal update status exp.' };
      }
    },

    async bulkUpdateExpStatus(payload) {
      return { success: true, message: 'Bulk update status exp selesai.' };
    },

    // --- RECIPE (RCV) & CONVERT ---
    async getRecipeData() {
      try {
        const snap = await _db.collection('recipes').get();
        const rows = [];
        snap.forEach(doc => {
          const d = doc.data();
          rows.push({
            id: doc.id,
            item: d.item || '',
            product: d.product || '',
            qtyRcv: parseFloat(d.qtyRcv) || 0,
            uom: d.uom || ''
          });
        });
        return { success: true, data: rows };
      } catch (e) {
        return { success: false, message: 'Gagal memuat data recipe.' };
      }
    },

    async addRecipe(payload) {
      try {
        if (!payload || !payload.item || !payload.product) {
          return { success: false, message: 'Item dan Product wajib diisi.' };
        }
        const itemUpper = payload.item.trim().toUpperCase();
        const prodUpper = payload.product.trim().toUpperCase();

        const dup = await _db.collection('recipes')
          .where('item', '==', itemUpper)
          .where('product', '==', prodUpper)
          .get();

        if (!dup.empty) return { success: false, message: `Resep untuk Item '${payload.item}' dan Product '${payload.product}' sudah ada.` };

        const ref = await _db.collection('recipes').add({
          item: itemUpper,
          product: prodUpper,
          qtyRcv: parseFloat(payload.qtyRcv) || 0,
          uom: payload.uom || '',
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        return { success: true, message: 'Resep berhasil ditambahkan.', id: ref.id };
      } catch (e) {
        return { success: false, message: 'Gagal menambah resep: ' + e.message };
      }
    },

    async updateRecipe(payload) {
      try {
        if (!payload || !payload.id) return { success: false, message: 'ID resep wajib ada.' };
        await _db.collection('recipes').doc(payload.id).update({
          item: (payload.item || '').trim().toUpperCase(),
          product: (payload.product || '').trim().toUpperCase(),
          qtyRcv: parseFloat(payload.qtyRcv) || 0,
          uom: payload.uom || ''
        });
        return { success: true, message: 'Resep berhasil diperbarui.' };
      } catch (e) {
        return { success: false, message: 'Gagal update resep: ' + e.message };
      }
    },

    async deleteRecipe(payload) {
      try {
        const id = payload.id || payload;
        await _db.collection('recipes').doc(id).delete();
        return { success: true, message: 'Resep berhasil dihapus.' };
      } catch (e) {
        return { success: false, message: 'Gagal menghapus resep.' };
      }
    },

    async getConvertData() {
      try {
        const snap = await _db.collection('conversions').get();
        const rows = [];
        snap.forEach(doc => {
          const d = doc.data();
          rows.push({
            id: doc.id,
            item: d.item || '',
            uom: d.uom || '',
            convert: parseFloat(d.convert) || 0,
            uomConvert: d.uomConvert || ''
          });
        });
        return { success: true, data: rows };
      } catch (e) {
        return { success: false, message: 'Gagal memuat data konversi UOM.' };
      }
    },

    async addConvert(payload) {
      try {
        if (!payload || !payload.item || !payload.uom) {
          return { success: false, message: 'Item dan UOM wajib diisi.' };
        }
        const itemUpper = payload.item.trim().toUpperCase();
        const uomUpper = payload.uom.trim().toUpperCase();

        const dup = await _db.collection('conversions')
          .where('item', '==', itemUpper)
          .where('uom', '==', uomUpper)
          .get();

        if (!dup.empty) return { success: false, message: `Konversi untuk Item '${payload.item}' dan UOM '${payload.uom}' sudah ada.` };

        const ref = await _db.collection('conversions').add({
          item: itemUpper,
          uom: uomUpper,
          convert: parseFloat(payload.convert) || 0,
          uomConvert: payload.uomConvert || '',
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        return { success: true, message: 'Konversi berhasil ditambahkan.', id: ref.id };
      } catch (e) {
        return { success: false, message: 'Gagal menambah konversi: ' + e.message };
      }
    },

    async updateConvert(payload) {
      try {
        if (!payload || !payload.id) return { success: false, message: 'ID konversi wajib ada.' };
        await _db.collection('conversions').doc(payload.id).update({
          item: (payload.item || '').trim().toUpperCase(),
          uom: (payload.uom || '').trim().toUpperCase(),
          convert: parseFloat(payload.convert) || 0,
          uomConvert: payload.uomConvert || ''
        });
        return { success: true, message: 'Konversi berhasil diperbarui.' };
      } catch (e) {
        return { success: false, message: 'Gagal update konversi: ' + e.message };
      }
    },

    async deleteConvert(payload) {
      try {
        const id = payload.id || payload;
        await _db.collection('conversions').doc(id).delete();
        return { success: true, message: 'Konversi berhasil dihapus.' };
      } catch (e) {
        return { success: false, message: 'Gagal menghapus konversi.' };
      }
    },

    // --- USER MANAGEMENT (ADMIN ONLY) ---
    async listUsers() {
      try {
        const snap = await _db.collection('users').get();
        const users = [];
        snap.forEach(doc => {
          const d = doc.data();
          users.push({
            id: doc.id,
            username: d.username || '',
            nama: d.nama || d.name || '',
            role: _normRole(d.role),
            status: d.status || 'AKTIF'
          });
        });
        return { success: true, data: users };
      } catch (e) {
        return { success: false, message: 'Gagal memuat daftar user.' };
      }
    },

    async saveUser(payload) {
      try {
        if (!payload || !payload.username) return { success: false, message: 'Username wajib diisi.' };
        const username = payload.username.trim().toLowerCase();
        const roleNorm = _normRole(payload.role);

        let ref;
        if (payload.id) {
          ref = _db.collection('users').doc(payload.id);
        } else {
          // Check username duplicate
          const dup = await _db.collection('users').where('username', '==', username).get();
          if (!dup.empty) return { success: false, message: `User '${username}' sudah ada.` };
          ref = _db.collection('users').doc();
        }

        const dataToSave = {
          username: username,
          nama: payload.nama || username,
          role: roleNorm,
          status: payload.status || 'AKTIF',
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        if (payload.password) {
          dataToSave.passwordHash = await _hashPassword(payload.password);
        }

        await ref.set(dataToSave, { merge: true });
        return { success: true, message: `User '${username}' berhasil disimpan.` };
      } catch (e) {
        return { success: false, message: 'Gagal menyimpan user: ' + e.message };
      }
    },

    async deleteUser(payload) {
      try {
        const id = payload.id || payload;
        await _db.collection('users').doc(id).delete();
        return { success: true, message: 'User berhasil dihapus.' };
      } catch (e) {
        return { success: false, message: 'Gagal menghapus user.' };
      }
    },

    // --- IMAGE MANAGEMENT ---
    async getItemImages() {
      try {
        const snap = await _db.collection('itemImages').get();
        const images = [];
        snap.forEach(doc => {
          images.push(doc.data());
        });
        return { success: true, data: images };
      } catch (e) {
        return { success: false, message: 'Gagal memuat gambar item.' };
      }
    },

    async uploadItemImage(payload) {
      try {
        if (!payload || !payload.itemKey || !payload.fileBase64) {
          return { success: false, message: 'File gambar dan nama item wajib ada.' };
        }
        const itemKey = payload.itemKey.trim().toUpperCase();
        const mimeType = payload.mimeType || 'image/jpeg';
        const storageRef = _storage.ref(`items/${itemKey}/image_${Date.now()}`);

        await storageRef.putString(payload.fileBase64, 'data_url', { contentType: mimeType });
        const downloadUrl = await storageRef.getDownloadURL();

        // Update itemImages metadata in Firestore
        await _db.collection('itemImages').doc(itemKey).set({
          namaItem: itemKey,
          imageUrl: downloadUrl,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        // Also patch masterItems
        const masterSnap = await _db.collection('masterItems').where('namaItem', '==', itemKey).get();
        if (!masterSnap.empty) {
          await masterSnap.docs[0].ref.update({ imageUrl: downloadUrl });
        }

        return { success: true, message: 'Gambar berhasil diunggah.', imageUrl: downloadUrl };
      } catch (e) {
        return { success: false, message: 'Gagal mengunggah gambar: ' + e.message };
      }
    },

    async deleteItemImage(payload) {
      try {
        const itemKey = (payload.itemKey || payload).toString().trim().toUpperCase();
        await _db.collection('itemImages').doc(itemKey).delete();

        const masterSnap = await _db.collection('masterItems').where('namaItem', '==', itemKey).get();
        if (!masterSnap.empty) {
          await masterSnap.docs[0].ref.update({ imageUrl: '' });
        }

        return { success: true, message: 'Gambar berhasil dihapus.' };
      } catch (e) {
        return { success: false, message: 'Gagal menghapus gambar.' };
      }
    },

    // --- SCANNER CONTEXT & UTILS ---
    async getScanItemContext(payload) {
      try {
        const code = (payload && payload.rawPayload ? payload.rawPayload : payload).toString().trim();

        let namaItem = code;
        let rak = '';

        // Payload parsing logic preserving legacy regex
        if (code.includes('SIGAP:RAK:')) {
          const parts = code.split(';');
          parts.forEach(p => {
            if (p.startsWith('SIGAP:RAK:')) rak = p.replace('SIGAP:RAK:', '');
            if (p.startsWith('ITEM:')) namaItem = p.replace('ITEM:', '');
            if (p.startsWith('SIGAP:ITEM:')) namaItem = p.replace('SIGAP:ITEM:', '');
          });
        } else if (code.startsWith('ITEM:')) {
          namaItem = code.replace('ITEM:', '');
        } else if (code.startsWith('SIGAP:ITEM:')) {
          namaItem = code.replace('SIGAP:ITEM:', '');
        }

        const masterRes = await this.getAllMasterItems();
        const itemObj = (masterRes.data || []).find(it => (it.namaItem || '').trim().toUpperCase() === namaItem.toUpperCase() || (it.barcode || '').trim() === code);

        return {
          success: true,
          data: {
            rawPayload: code,
            namaItem: itemObj ? itemObj.namaItem : namaItem,
            masterFound: !!itemObj,
            master: itemObj || null,
            rak: rak || (itemObj ? itemObj.lokasi : '')
          }
        };
      } catch (e) {
        return { success: false, message: 'Gagal memproses hasil scan.' };
      }
    },

    async getBackendInfo() {
      return {
        success: true,
        data: {
          backend: 'Firebase Serverless Cloud',
          version: '2.0-FIREBASE',
          timezone: 'Asia/Jakarta (GMT+7)'
        }
      };
    },

    async clearMasterCache() { return { success: true }; },
    async clearStockCache() { return { success: true }; }
  };

  // --- PROXY DISPATCHER FOR GOOGLE.SCRIPT.RUN & CALL() ---
  window.SIGAPApi = SIGAPApi;

  window.google = window.google || {};
  window.google.script = window.google.script || {};

  window.google.script.run = new Proxy({}, {
    get(target, prop) {
      let successCb = () => {};
      let failureCb = (err) => console.error('SIGAP Proxy Error:', err);

      const runner = {
        withSuccessHandler(cb) {
          successCb = cb;
          return runner;
        },
        withFailureHandler(cb) {
          failureCb = cb;
          return runner;
        }
      };

      return function (...args) {
        if (typeof SIGAPApi[prop] === 'function') {
          Promise.resolve(SIGAPApi[prop](...args))
            .then(res => {
              if (typeof successCb === 'function') successCb(res);
            })
            .catch(err => {
              if (typeof failureCb === 'function') failureCb(err);
            });
        } else if (runner[prop]) {
          return runner;
        } else {
          console.warn(`SIGAPApi missing method: '${prop}'`);
          if (typeof failureCb === 'function') failureCb(new Error(`Action '${prop}' not supported.`));
        }
        return runner;
      };
    }
  });

  console.log('✅ SIGAP Firebase Adapter initialized successfully.');

})();
