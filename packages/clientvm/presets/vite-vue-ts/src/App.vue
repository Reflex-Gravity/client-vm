<script setup lang="ts">
import { ref } from 'vue';

const count = ref(0);
</script>

<template>
  <main>
    <h1>Vite + Vue + TS</h1>
    <button type="button" @click="count++">count is {{ count }}</button>
    <p>Edit <code>src/App.vue</code> and save to test HMR.</p>
  </main>
</template>
