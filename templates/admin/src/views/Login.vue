<template>
  <div style="display:flex;justify-content:center;align-items:center;min-height:80vh;">
    <div style="background:rgba(255,255,255,0.05);padding:40px;border-radius:16px;width:100%;max-width:400px;">
      <h2 style="text-align:center;margin-bottom:30px;color:#e94560;">Login Admin</h2>
      <form @submit.prevent="login">
        <div style="margin-bottom:20px;">
          <label style="display:block;margin-bottom:8px;color:#a0a0a0;">Email</label>
          <input v-model="email" type="email" required style="width:100%;padding:12px;border:1px solid rgba(255,255,255,0.2);border-radius:8px;background:rgba(255,255,255,0.05);color:#fff;" />
        </div>
        <div style="margin-bottom:20px;">
          <label style="display:block;margin-bottom:8px;color:#a0a0a0;">Password</label>
          <input v-model="password" type="password" required style="width:100%;padding:12px;border:1px solid rgba(255,255,255,0.2);border-radius:8px;background:rgba(255,255,255,0.05);color:#fff;" />
        </div>
        <p v-if="error" style="color:#ff6b6b;margin-bottom:15px;font-size:0.9rem;">{{ error }}</p>
        <button type="submit" :disabled="loading" style="width:100%;padding:14px;background:linear-gradient(135deg,#e94560,#ff6b6b);border:none;border-radius:8px;color:#fff;font-weight:600;cursor:pointer;">{{ loading ? 'Loading...' : 'Login' }}</button>
      </form>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import axios from 'axios'

const router = useRouter()
const email = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)

const login = async () => {
  loading.value = true
  error.value = ''
  try {
    const res = await axios.post('/api/auth/login', { email: email.value, password: password.value })
    localStorage.setItem('cafe_token', res.data.token)
    localStorage.setItem('cafe_user', JSON.stringify(res.data.user))
    router.push('/admin/dashboard')
  } catch (e) {
    error.value = e.response?.data?.error || 'Login failed'
  }
  loading.value = false
}
</script>
