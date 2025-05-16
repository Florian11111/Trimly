name := """backend"""
organization := "com.example"

version := "1.0-SNAPSHOT"

lazy val root = (project in file(".")).enablePlugins(PlayScala)

scalaVersion := "2.13.16"

libraryDependencies += guice
libraryDependencies += "org.scalatestplus.play" %% "scalatestplus-play" % "7.0.1" % Test
libraryDependencies += "org.scalatest" %% "scalatest" % "3.2.18" % Test
libraryDependencies += "com.typesafe.akka" %% "akka-actor" % "2.6.21"
libraryDependencies += "org.apache.pekko" %% "pekko-actor" % "1.0.2"
libraryDependencies += "org.apache.pekko" %% "pekko-stream" % "1.0.2"
libraryDependencies += "com.lihaoyi" %% "upickle" % "3.1.3"


