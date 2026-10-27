package com.charles.bento

import android.app.Application
import android.content.Context

class BentoApp : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
        graph.start()
    }
}

/** The app's singletons (stores, sync, dictation), shared by activities, services and widgets. */
val Context.graph: AppGraph get() = (applicationContext as BentoApp).graph
